import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { SuperfanAccessory } from './accessory.js';
import { readCache, writeCache } from './cache.js';
import { discoverFromCloud, type Credentials, type Discovery } from './cloud/discover.js';
import { CloudAuthError, KiotCloud } from './cloud/kiotCloud.js';
import { FanController } from './controller.js';
import { findFanViaMdns, resolveHost } from './local/discovery.js';
import { FanClient } from './local/fanClient.js';
import { DEFAULT_POLL_INTERVAL_S, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { FanRecord, Logger } from './types.js';

const ISSUES_URL = 'https://github.com/plugpulled/homebridge-superfan/issues';

export interface DeviceOverride {
  deviceId: string;
  host?: string;
  model?: string;
}

export interface SuperfanConfig {
  email: string;
  password: string;
  pollInterval: number;
  devices: DeviceOverride[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Validate the platform block from config.json. Never echoes credential values. */
export function parseConfig(raw: PlatformConfig): SuperfanConfig {
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  if (!email) throw new ConfigError('"email" is required in the plugin settings');
  if (!nonEmpty(raw.password)) throw new ConfigError('"password" is required in the plugin settings');

  const interval = Number(raw.pollInterval ?? DEFAULT_POLL_INTERVAL_S);
  const pollInterval = Math.min(300, Math.max(2, Number.isFinite(interval) ? interval : DEFAULT_POLL_INTERVAL_S));

  const devices = (Array.isArray(raw.devices) ? raw.devices : [])
    .filter((d: Record<string, unknown>) => nonEmpty(d?.deviceId))
    .map((d: Record<string, unknown>) => {
      // Accept the fan's network name too ("fan_<deviceId>", maybe with ".local").
      const deviceId = (d.deviceId as string).trim().toLowerCase().replace(/^fan_/, '').replace(/\.local\.?$/, '');
      const o: DeviceOverride = { deviceId };
      if (nonEmpty(d.host)) o.host = d.host.trim();
      if (nonEmpty(d.model)) o.model = d.model.trim();
      return o;
    });

  return { email, password: raw.password, pollInterval, devices };
}

/**
 * Get the fan list: from the cloud (and refresh the cache), else from the cache.
 * `fans: undefined` means "unknown" (no cloud, no cache) — not "no fans".
 */
export async function loadFans(d: {
  discover: () => Promise<Discovery>;
  cachePath: string;
  log: Logger;
}): Promise<{ fans?: FanRecord[]; lastHosts: Record<string, string>; keepIds: string[] }> {
  const cache = await readCache(d.cachePath);
  const lastHosts = cache?.lastHosts ?? {};
  try {
    const { fans, skipped } = await d.discover();
    for (const s of skipped) {
      d.log.warn(`Skipping "${s.name}" (${s.reason}); please open an issue at ${ISSUES_URL}`);
    }
    // Fans still on the account but not usable keep their Home accessory (and the user's automations).
    const keepIds = skipped.flatMap((s) => (s.deviceId ? [s.deviceId] : []));
    if (fans.length === 0 && skipped.length === 0 && cache?.fans.length) {
      d.log.warn('Superfan reported no fans on your account; keeping the saved fans. Remove them in Homebridge if they are really gone.');
      return { fans: cache.fans, lastHosts, keepIds };
    }
    await writeCache(d.cachePath, { version: 1, fans, lastHosts });
    return { fans, lastHosts, keepIds };
  } catch (error) {
    const why = error instanceof CloudAuthError
      ? 'Superfan login failed: check email/password in the plugin settings'
      : `Superfan cloud unavailable (${(error as Error).message})`;
    if (cache) {
      d.log.warn(`${why}; using saved fan details`);
      return { fans: cache.fans, lastHosts, keepIds: [] };
    }
    d.log.error(`${why}; no saved fan details yet, so no fans can be set up`);
    return { fans: undefined, lastHosts, keepIds: [] };
  }
}

export function planAccessories(
  existingUuids: string[],
  fans: FanRecord[],
  uuidFor: (deviceId: string) => string,
): { create: FanRecord[]; restore: FanRecord[]; remove: string[] } {
  const existing = new Set(existingUuids);
  const wanted = new Set(fans.map((f) => uuidFor(f.deviceId)));
  return {
    create: fans.filter((f) => !existing.has(uuidFor(f.deviceId))),
    restore: fans.filter((f) => existing.has(uuidFor(f.deviceId))),
    remove: existingUuids.filter((u) => !wanted.has(u)),
  };
}

export interface PlatformDeps {
  discover: (creds: Credentials) => Promise<Discovery>;
  findFanViaMdns: (deviceId: string) => Promise<string | undefined>;
  createClient: (o: { host?: string; apikey: string; apiSecret: string }) => FanClient;
}

export class SuperfanPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly controllers: FanController[] = [];
  private readonly config?: SuperfanConfig;
  private readonly deps: PlatformDeps;
  /** One cloud lookup shared by every fan asking for new keys at the same time. */
  private keyLookup?: Promise<Discovery>;
  /** Cache updates run one after another, so two fans saving at once can't overwrite each other. */
  private cacheSaves: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: Logging,
    rawConfig: PlatformConfig,
    private readonly api: API,
    deps?: Partial<PlatformDeps>,
  ) {
    this.deps = {
      discover: (creds) => discoverFromCloud(new KiotCloud(), creds, this.log),
      findFanViaMdns: (id) => findFanViaMdns(id),
      createClient: (o) => new FanClient(o),
      ...deps,
    };
    try {
      this.config = parseConfig(rawConfig);
    } catch (error) {
      this.log.error((error as Error).message);
      return;
    }
    this.api.on('didFinishLaunching', () => {
      this.start().catch((error: Error) => this.log.error(`Startup failed (${error.message})`));
    });
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private uuidFor(deviceId: string): string {
    return this.api.hap.uuid.generate(`superfan:${deviceId}`);
  }

  private get cachePath(): string {
    return join(this.api.user.storagePath(), 'superfan', 'cache.json');
  }

  private get creds(): Credentials {
    return { email: this.config!.email, password: this.config!.password };
  }

  /** A fan keeps refusing its keys: fetch its current record from the cloud (one shared login). */
  private async refreshKeys(deviceId: string): Promise<FanRecord | undefined> {
    this.keyLookup ??= this.deps.discover(this.creds).finally(() => {
      this.keyLookup = undefined;
    });
    const latest = (await this.keyLookup).fans.find((f) => f.deviceId === deviceId);
    if (latest) {
      void this.saveFan(latest); // in the background: new keys must not wait for the disk
    }
    return latest;
  }

  /** Replace one fan's saved details (e.g. new keys). Failures are logged, never thrown. */
  private saveFan(fan: FanRecord): Promise<void> {
    this.cacheSaves = this.cacheSaves.then(() => this.writeFan(fan));
    return this.cacheSaves;
  }

  private async writeFan(fan: FanRecord): Promise<void> {
    try {
      const cache = await readCache(this.cachePath);
      if (cache) {
        await writeCache(this.cachePath, { ...cache, fans: [...cache.fans.filter((f) => f.deviceId !== fan.deviceId), fan] });
      }
    } catch (error) {
      this.log.debug(`Could not update saved fan details (${(error as Error).message})`);
    }
  }

  private async start(): Promise<void> {
    const config = this.config!;
    const cachePath = this.cachePath;
    const { fans, lastHosts, keepIds } = await loadFans({ discover: () => this.deps.discover(this.creds), cachePath, log: this.log });
    if (!fans) {
      return; // unknown: keep restored accessories untouched
    }

    for (const o of config.devices) {
      if (!fans.some((f) => f.deviceId === o.deviceId)) {
        this.log.warn(`Settings mention fan "${o.deviceId}", but no fan with that device ID is on your account; that override is ignored`);
      }
    }

    const plan = planAccessories([...this.cached.keys()], fans, (id) => this.uuidFor(id));
    const keep = new Set(keepIds.map((id) => this.uuidFor(id)));
    const stale = plan.remove.filter((u) => !keep.has(u)).map((u) => this.cached.get(u)!).filter(Boolean);
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) this.cached.delete(a.UUID);
    }

    const hosts: Record<string, string> = {};
    const created: PlatformAccessory[] = [];
    for (const fan of fans) {
      try {
        const host = await this.setupFan(fan, lastHosts[fan.deviceId], created);
        if (host) hosts[fan.deviceId] = host;
      } catch (error) {
        this.log.error(`Could not set up "${fan.name}" (device ID ${fan.deviceId}): ${(error as Error).message}`);
      }
    }

    if (created.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created);
    }

    const cache = await readCache(cachePath);
    if (cache) {
      await writeCache(cachePath, { ...cache, lastHosts: { ...cache.lastHosts, ...hosts } });
    }
  }

  /** Set up one fan's accessory and controller. Returns the address it was found at, if any. */
  private async setupFan(fan: FanRecord, lastHost: string | undefined, created: PlatformAccessory[]): Promise<string | undefined> {
    const config = this.config!;
    const override = config.devices.find((d) => d.deviceId === fan.deviceId);
    const host = await resolveHost({
      override: override?.host,
      cloudHost: fan.cloudHost,
      lastHost,
      mdns: () => this.deps.findFanViaMdns(fan.deviceId),
    });
    if (!host) {
      this.log.warn(`Could not find "${fan.name}" (device ID ${fan.deviceId}) on the network yet; will keep looking. If this persists, set its "host" in the plugin settings`);
    }

    const client = this.deps.createClient({ host, apikey: fan.apikey, apiSecret: fan.apiSecret });
    const firmware = host ? await client.ping().then((p) => p.version || undefined).catch(() => undefined) : undefined;

    const uuid = this.uuidFor(fan.deviceId);
    const accessory = this.cached.get(uuid) ?? new this.api.platformAccessory(fan.name, uuid);
    accessory.context.deviceId = fan.deviceId;

    const controller = new FanController({
      client,
      fan,
      pollIntervalMs: config.pollInterval * 1000,
      log: this.log,
      // Local lookup only: an unpowered fan would otherwise mean a cloud login every few minutes,
      // and the cloud just reports the same last-known IP anyway.
      reresolve: override?.host ? undefined : () => this.deps.findFanViaMdns(fan.deviceId),
      // Only on repeated "access denied" (fan re-added in the app), never for an unreachable fan.
      refreshKeys: () => this.refreshKeys(fan.deviceId),
      host,
    });
    new SuperfanAccessory({
      hap: this.api.hap,
      accessory,
      fan: override?.model ? { ...fan, model: override.model } : fan,
      controller,
      firmware,
      log: this.log,
    });
    if (!this.cached.has(uuid)) {
      created.push(accessory);
    }
    controller.start();
    this.controllers.push(controller);
    if (host) {
      this.log.info(`"${fan.name}" (device ID ${fan.deviceId}) ready at ${host}`);
    }
    return host;
  }

  private stop(): void {
    for (const c of this.controllers) c.stop();
  }
}
