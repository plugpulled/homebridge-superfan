import { EventEmitter } from 'node:events';
import { CloudAuthError } from './cloud/kiotCloud.js';
import { FanHttpError, type FanClientLike } from './local/fanClient.js';
import { KEY_REFRESH_RETRY_MS, OFFLINE_AFTER_FAILURES, OFFLINE_BACKOFF_CAP_MS, REREAD_AFTER_COMMAND_MS, SPEED_SETTLE_MS } from './settings.js';
import { fromDimm, toDimm } from './speed.js';
import type { FanRecord, FanState, FanStatus, Logger } from './types.js';

const RERESOLVE_MIN_GAP_MS = 5 * 60_000;

/** Thrown by commands while the fan is unreachable. */
export class OfflineError extends Error {
  constructor(fanName: string) {
    super(`${fanName} is not responding`);
    this.name = 'OfflineError';
  }
}

export interface FanControllerLike {
  readonly state: FanState;
  setFanOn(on: boolean): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  setLight(on: boolean): Promise<void>;
  on(event: 'change', listener: (state: FanState) => void): this;
}

export interface FanControllerOptions {
  client: FanClientLike;
  fan: FanRecord;
  pollIntervalMs: number;
  log: Logger;
  /** Finds the fan's current address when it stops answering (mDNS, cloud). */
  reresolve?: () => Promise<string | undefined>;
  /**
   * Fetches this fan's current record (with keys) from the cloud, or undefined if it is no longer
   * on the account. Rejects with CloudAuthError on a wrong password, any other Error on cloud trouble.
   */
  refreshKeys?: () => Promise<FanRecord | undefined>;
  /** The address the client starts with (undefined if not found yet); used to tell whether a lookup found a new one. */
  host?: string;
}

/**
 * Owns one fan's state: polls it, sends commands with optimistic updates,
 * and tracks reachability (offline after repeated failures, with backoff).
 */
export class FanController extends EventEmitter implements FanControllerLike {
  private readonly client: FanClientLike;
  private readonly fan: FanRecord;
  private readonly pollIntervalMs: number;
  private readonly log: Logger;
  private readonly reresolve?: () => Promise<string | undefined>;
  private readonly refreshKeys?: () => Promise<FanRecord | undefined>;

  private current: FanState = { online: true, fanOn: false, speed: 1, lightOn: false };
  private failures = 0;
  private commandSeq = 0;
  private commandsInFlight = 0;
  /** Bumped by every command's optimistic update; a failed command only rolls back if no newer one followed. */
  private optimisticSeq = 0;
  private lastReresolve?: number;
  private keyRefreshInFlight = false;
  private keyRefreshStopped = false;
  private nextKeyRefreshAt = 0;
  /** Consecutive failed reads that were "access denied" (any success or other failure resets it). */
  private consecutive403 = 0;
  private host?: string;
  /** When the last speed command was sent (cleared by "off"); see SPEED_SETTLE_MS. */
  private lastSpeedCommandAt?: number;
  private pollTimer?: NodeJS.Timeout;
  private rereadTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(options: FanControllerOptions) {
    super();
    this.client = options.client;
    this.fan = { ...options.fan }; // own copy: keys change when the fan is re-added in the app
    this.pollIntervalMs = options.pollIntervalMs;
    this.log = options.log;
    this.reresolve = options.reresolve;
    this.refreshKeys = options.refreshKeys;
    this.host = options.host;
  }

  get state(): FanState {
    return { ...this.current };
  }

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.rereadTimer);
  }

  async setFanOn(on: boolean): Promise<void> {
    this.assertOnline();
    if (on && this.speedSettling()) {
      // A speed command was just sent and already keeps the fan running (it even starts a stopped fan).
      // Sending "on" now would make the firmware fall back to the previous speed.
      this.update({ fanOn: true });
      return;
    }
    if (!on) {
      this.lastSpeedCommandAt = undefined; // after "off", a following "on" must be sent
    }
    // Always send: the cached state may be stale (e.g. the remote was used since the last poll).
    // A repeated relay-on during a speed change is harmless.
    await this.optimistic({ fanOn: on }, () => this.client.setRelay(this.fan.fanSwitchNo, on));
  }

  async setSpeed(speed: number): Promise<void> {
    this.assertOnline();
    if (speed <= 0) {
      return this.setFanOn(false);
    }
    const wasOn = this.current.fanOn;
    this.lastSpeedCommandAt = Date.now();
    await this.optimistic({ speed, fanOn: true }, async () => {
      // "On" first, then the speed: the other order makes the firmware fall back to the old speed.
      if (!wasOn) {
        await this.client.setRelay(this.fan.fanSwitchNo, true);
      }
      await this.client.setDimmer(this.fan.fanSwitchNo, toDimm(speed, this.fan.steps));
    });
  }

  async setLight(on: boolean): Promise<void> {
    this.assertOnline();
    const lightSwitchNo = this.fan.lightSwitchNo;
    if (lightSwitchNo === undefined) {
      return;
    }
    await this.optimistic({ lightOn: on }, () => this.client.setRelay(lightSwitchNo, on));
  }

  private speedSettling(): boolean {
    return this.lastSpeedCommandAt !== undefined && Date.now() - this.lastSpeedCommandAt < SPEED_SETTLE_MS;
  }

  private assertOnline(): void {
    if (!this.current.online) {
      throw new OfflineError(this.fan.name);
    }
  }

  /** Show `patch` right away, send the command, and put the old values back if it fails. */
  private async optimistic(patch: Partial<FanState>, send: () => Promise<unknown>): Promise<void> {
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, this.current[k as keyof FanState]])) as Partial<FanState>;
    const mine = ++this.optimisticSeq;
    this.update(patch);
    try {
      await this.command(send);
    } catch (error) {
      if (this.optimisticSeq === mine) {
        this.update(before);
      }
      throw error;
    }
  }

  /** Runs a command; whatever happens, re-read the real state shortly after. */
  private async command(send: () => Promise<unknown>): Promise<void> {
    this.commandSeq++;
    this.commandsInFlight++;
    try {
      await send();
    } finally {
      // Bump again so any read that started *during* the command (and may have been queued
      // between its requests) is discarded; the re-read below reports the settled state.
      this.commandsInFlight--;
      this.commandSeq++;
      this.scheduleReread();
    }
  }

  private scheduleReread(): void {
    clearTimeout(this.rereadTimer);
    this.rereadTimer = setTimeout(() => void this.read(), REREAD_AFTER_COMMAND_MS);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    await this.read();
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.poll(), this.nextPollDelay());
  }

  private nextPollDelay(): number {
    if (this.failures < OFFLINE_AFTER_FAILURES) {
      return this.pollIntervalMs;
    }
    return Math.min(this.pollIntervalMs * 2 ** (this.failures - OFFLINE_AFTER_FAILURES + 1), OFFLINE_BACKOFF_CAP_MS);
  }

  private async read(): Promise<void> {
    const seqAtStart = this.commandSeq;
    let status: FanStatus;
    try {
      status = await this.client.getStatus();
    } catch (error) {
      await this.onReadFailure(error);
      return;
    }
    if (this.stopped) return;
    if (status.relays[this.fan.fanSwitchNo - 1] === undefined) {
      // A reply that doesn't say whether the fan is on is not "off": count it as a failed read.
      await this.onReadFailure(new Error('status reply without the fan relay'));
      return;
    }
    this.consecutive403 = 0;
    if (this.failures > 0 || !this.current.online) {
      if (!this.current.online) {
        this.log.info(`${this.fan.name} is reachable again`);
      }
      this.failures = 0;
      this.update({ online: true });
    }
    if (seqAtStart !== this.commandSeq || this.commandsInFlight > 0) {
      return; // overlapped a command; the re-read after that command will report
    }
    this.applyStatus(status);
  }

  private async onReadFailure(error: unknown): Promise<void> {
    if (this.stopped) return;
    this.failures++;
    this.consecutive403 = error instanceof FanHttpError && error.status === 403 ? this.consecutive403 + 1 : 0;
    if (this.failures < OFFLINE_AFTER_FAILURES) {
      return;
    }
    if (this.current.online) {
      this.log.warn(`${this.fan.name} is not responding; will keep retrying`);
      this.update({ online: false });
    }
    // Look locally first: a 403 can also come from another device that took over the fan's old address.
    const moved = await this.tryReresolve();
    if (this.stopped || moved) return;
    // Repeated "access denied" at the fan's own address: its keys changed (re-added in the app).
    if (this.consecutive403 >= OFFLINE_AFTER_FAILURES) {
      this.refreshKeysSoon();
    }
  }

  /** Ask the cloud for this fan's keys, at most one request at a time; never blocks polling. */
  private refreshKeysSoon(): void {
    if (!this.refreshKeys || this.keyRefreshInFlight || this.keyRefreshStopped || Date.now() < this.nextKeyRefreshAt) return;
    this.keyRefreshInFlight = true;
    void this.refreshKeys()
      .then((latest) => this.onKeys(latest), (error: unknown) => this.onKeysFailed(error))
      .finally(() => {
        this.keyRefreshInFlight = false;
      });
  }

  private onKeys(latest: FanRecord | undefined): void {
    if (this.discardKeyResult()) return;
    if (latest && (latest.apikey !== this.fan.apikey || latest.apiSecret !== this.fan.apiSecret)) {
      this.fan.apikey = latest.apikey;
      this.fan.apiSecret = latest.apiSecret;
      this.client.setKeys(latest.apikey, latest.apiSecret);
      this.log.info(`${this.fan.name}: picked up new keys from your Superfan account`);
      return;
    }
    this.keyRefreshStopped = true;
    this.log.warn(`${this.fan.name} refused the plugin's keys and your Superfan account has no newer ones. Check that the Homebridge server's clock is correct, then restart Homebridge`);
  }

  private onKeysFailed(error: unknown): void {
    if (this.discardKeyResult()) return;
    if (error instanceof CloudAuthError) {
      this.keyRefreshStopped = true;
      this.log.warn(`${this.fan.name} refused the plugin's keys, and Superfan login failed: check email/password in the plugin settings, then restart Homebridge`);
      return;
    }
    this.nextKeyRefreshAt = Date.now() + KEY_REFRESH_RETRY_MS;
    this.log.debug(`${this.fan.name}: could not fetch new keys (${(error as Error).message}); will retry in 30 minutes`);
  }

  /** A refresh result arriving after shutdown, or after the fan recovered by itself, is ignored. */
  private discardKeyResult(): boolean {
    if (this.stopped) return true;
    if (this.current.online) {
      // Still wait before the next refresh, so a fan flapping between 403s and answers can't loop logins.
      this.nextKeyRefreshAt = Date.now() + KEY_REFRESH_RETRY_MS;
      return true;
    }
    return false;
  }

  /** Look the fan up locally (rate-limited). Returns true if it was found at a different address. */
  private async tryReresolve(): Promise<boolean> {
    if (!this.reresolve) return false;
    const now = Date.now();
    if (this.lastReresolve !== undefined && now - this.lastReresolve < RERESOLVE_MIN_GAP_MS) return false;
    this.lastReresolve = now;
    try {
      const host = await this.reresolve();
      if (host && host !== this.host && !this.stopped) {
        this.host = host;
        this.client.setHost(host);
        this.log.debug(`${this.fan.name}: trying address ${host}`);
        return true;
      }
    } catch {
      this.log.debug(`${this.fan.name}: address lookup failed`);
    }
    return false;
  }

  private applyStatus(status: FanStatus): void {
    const relay = (switchNo: number | undefined): boolean => switchNo !== undefined && status.relays[switchNo - 1] === 1;
    this.update({
      fanOn: relay(this.fan.fanSwitchNo),
      lightOn: relay(this.fan.lightSwitchNo),
      speed: status.dimmer === undefined ? this.current.speed : fromDimm(status.dimmer, this.fan.steps),
    });
  }

  private update(patch: Partial<FanState>): void {
    const next = { ...this.current, ...patch };
    const changed = (Object.keys(next) as (keyof FanState)[]).some((k) => next[k] !== this.current[k]);
    this.current = next;
    if (changed) {
      this.emit('change', this.state);
    }
  }
}
