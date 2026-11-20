import { CLOUD_AUTH_BASE_URL, CLOUD_BASE_URL, PARTNER_ID } from '../settings.js';

export interface Session {
  token: string;
}

/** Superfan rejected the email/password. */
export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudAuthError';
  }
}

export interface KiotCloudOptions {
  baseUrl?: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Minimal client for the KIOT cloud used by the Superfan app (discovery only). */
export class KiotCloud {
  private readonly baseUrl: string;
  private readonly authBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: KiotCloudOptions = {}) {
    this.baseUrl = options.baseUrl ?? CLOUD_BASE_URL;
    this.authBaseUrl = options.authBaseUrl ?? CLOUD_AUTH_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async login(email: string, password: string): Promise<Session> {
    const { status, body } = await this.request('POST', this.authBaseUrl, 'user/authenticate_v2', undefined, {
      email,
      password,
      loginType: 'password',
      partner: PARTNER_ID,
    });
    if (status === 400 || status === 401 || status === 403) {
      throw new CloudAuthError(`Superfan login failed (HTTP ${status})`);
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Superfan cloud login failed: HTTP ${status}`);
    }
    const token = (body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new CloudAuthError('Superfan login failed (no session returned)');
    }
    return { token };
  }

  async getHomeIds(token: string): Promise<string[]> {
    const body = await this.get(token, 'homes/myhomes?only_ids=true');
    if (!Array.isArray(body)) {
      throw new Error('Superfan cloud returned an unexpected homes list');
    }
    return body
      .map((h: unknown) => (typeof h === 'string' ? h : (h as { _id?: unknown } | null)?._id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  async getDevices(token: string, homeId: string): Promise<unknown> {
    const body = await this.get(token, `userdevices/mydevices?home=${encodeURIComponent(homeId)}&append=room,swappliance,kiotdevice`);
    // An unexpected shape must fail loudly: treating it as "no fans" would remove the user's accessories.
    if (!body || typeof body !== 'object' || !Array.isArray((body as { rooms?: unknown }).rooms)) {
      throw new Error('Superfan cloud returned an unexpected device list');
    }
    return body;
  }

  async getIps(token: string, homeId: string): Promise<Record<string, string>> {
    const body = await this.get(token, `userdevices/get_ips?home_id=${encodeURIComponent(homeId)}`);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    return Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }

  private async get(token: string, path: string): Promise<unknown> {
    const { status, body } = await this.request('GET', this.baseUrl, path, token);
    if (status < 200 || status >= 300) {
      throw new Error(`Superfan cloud request failed: HTTP ${status} for ${path.split('?')[0]}`);
    }
    return body;
  }

  private async request(
    method: 'GET' | 'POST',
    base: string,
    path: string,
    token?: string,
    json?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.fetchImpl(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error(`Superfan cloud unreachable (${path.split('?')[0]})`);
    }
    const text = await response.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }
}
