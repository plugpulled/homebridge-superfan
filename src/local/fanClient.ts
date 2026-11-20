import { createHmac } from 'node:crypto';
import type { FanStatus } from '../types.js';

/** `meta1` has 100 ms resolution; keep consecutive requests further apart than that. */
const MIN_REQUEST_SPACING_MS = 110;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface PingInfo {
  version: string;
  deviceId: string;
  hostname: string;
}

/** Error from talking to a fan. `status` is the HTTP status, or 0 for network errors and timeouts. */
export class FanHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FanHttpError';
    this.status = status;
  }
}

/** Request signature used by the fan firmware: HMAC-SHA256(apiSecret, meta1 + "," + apikey). */
export function signAuth(apikey: string, apiSecret: string, nowMs: number): { meta: string; meta1: string } {
  const meta1 = String(nowMs).slice(2, 11);
  const meta = createHmac('sha256', apiSecret).update(`${meta1},${apikey}`).digest('hex');
  return { meta, meta1 };
}

/** Normalise the fan's `/api/switch` reply. Malformed parts become empty/undefined. */
export function parseStatus(body: unknown): FanStatus {
  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const relays = Array.isArray(obj.relays) ? obj.relays.map((r) => (r === 1 || r === true ? 1 : 0)) : [];
  let dimmer: number | undefined;
  if (typeof obj.dimmer === 'number') {
    dimmer = obj.dimmer;
  } else if (Array.isArray(obj.dimmers) && typeof obj.dimmers[0] === 'number') {
    dimmer = obj.dimmers[0];
  }
  return { relays, dimmer };
}

export interface FanClientOptions {
  host: string;
  apikey: string;
  apiSecret: string;
  timeoutMs?: number;
  /** Clock used for request signing (injectable for tests). */
  now?: () => number;
}

/** Signed HTTP client for one fan. Requests are serialised: at most one is in flight. */
export class FanClient {
  private host: string;
  private readonly apikey: string;
  private readonly apiSecret: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;

  constructor(options: FanClientOptions) {
    this.host = options.host;
    this.apikey = options.apikey;
    this.apiSecret = options.apiSecret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  setHost(host: string): void {
    this.host = host;
  }

  async ping(): Promise<PingInfo> {
    const body = await this.enqueue('GET', '/ping', false);
    const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    return {
      version: String(obj.version ?? ''),
      deviceId: String(obj.deviceId ?? ''),
      hostname: String(obj.hostname ?? ''),
    };
  }

  async getStatus(): Promise<FanStatus> {
    return parseStatus(await this.enqueue('GET', '/api/switch', true));
  }

  async setRelay(switchNo: number, on: boolean): Promise<FanStatus | undefined> {
    // Firmware 4.2.0 parses value as a number: "true"/"false" both read as 0 (off). Verified on a real fan.
    return this.command(`key=${switchNo}&value=${on ? 1 : 0}`);
  }

  async setDimmer(switchNo: number, value: number): Promise<FanStatus | undefined> {
    return this.command(`key=${switchNo}&value=${value}&is_dimmer=true`);
  }

  private async command(form: string): Promise<FanStatus | undefined> {
    const body = await this.enqueue('POST', '/api/switch', true, form);
    const hasRelays = typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>).relays);
    return hasRelays ? parseStatus(body) : undefined;
  }

  private enqueue(method: 'GET' | 'POST', path: string, auth: boolean, form?: string): Promise<unknown> {
    const run = this.chain.then(() => this.send(method, path, auth, form));
    // Keep the queue alive regardless of this request's outcome.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async send(method: 'GET' | 'POST', path: string, auth: boolean, form?: string): Promise<unknown> {
    const wait = this.lastStart + MIN_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastStart = Date.now();

    let url = `http://${this.host}${path}`;
    if (auth) {
      const { meta, meta1 } = signAuth(this.apikey, this.apiSecret, this.now());
      url += `?${new URLSearchParams({ apikey: this.apikey, meta, meta1 })}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: form === undefined ? undefined : { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FanHttpError(0, `Fan at ${this.host} did not respond to ${method} ${path}`);
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new FanHttpError(response.status, `Fan at ${this.host} returned HTTP ${response.status} for ${method} ${path}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

export type FanClientLike = Pick<FanClient, 'getStatus' | 'setRelay' | 'setDimmer' | 'setHost'>;
