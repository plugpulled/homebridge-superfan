import { afterEach, describe, expect, test } from 'vitest';
import { FanClient, FanHttpError, parseStatus, signAuth } from '../src/local/fanClient.js';
import { json, startFakeFan, text, type FakeFan } from './helpers/fakeFan.js';

const AK = 'ak_test_123';
const SK = 'sk_test_456';
const NOW = 1795000123456;
// Hand-computed with node:crypto: HMAC-SHA256(key=SK, msg="950001234,ak_test_123")
const META1 = '950001234';
const META = '5bfb667d4b98b72d894f4cb6fb2c116e152a6172f7022b20fe23889f5c46bd40';

const fans: FakeFan[] = [];
async function fakeFan(...args: Parameters<typeof startFakeFan>): Promise<FakeFan> {
  const f = await startFakeFan(...args);
  fans.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(fans.splice(0).map((f) => f.close()));
});

function client(host: string, extra: Partial<ConstructorParameters<typeof FanClient>[0]> = {}): FanClient {
  return new FanClient({ host, apikey: AK, apiSecret: SK, now: () => NOW, ...extra });
}

describe('signAuth', () => {
  test('matches the app algorithm', () => {
    expect(signAuth(AK, SK, NOW)).toEqual({ meta1: META1, meta: META });
  });
});

describe('parseStatus', () => {
  test('keeps relays and single dimmer', () => {
    expect(parseStatus({ relays: [1, 0], dimmer: 60 })).toEqual({ relays: [1, 0], dimmer: 60 });
  });
  test('takes the first entry of dimmers[]', () => {
    expect(parseStatus({ relays: [0, 1], dimmers: [40] })).toEqual({ relays: [0, 1], dimmer: 40 });
  });
  test('converts boolean relays to 0/1', () => {
    expect(parseStatus({ relays: [true, false] })).toEqual({ relays: [1, 0], dimmer: undefined });
  });
  test('tolerates malformed bodies', () => {
    expect(parseStatus({ relays: 'x' })).toEqual({ relays: [], dimmer: undefined });
    expect(parseStatus(null)).toEqual({ relays: [], dimmer: undefined });
  });
});

describe('FanClient against a fake fan', () => {
  test('getStatus sends a signed GET /api/switch and parses the reply', async () => {
    const fan = await fakeFan((_req, res) => json(res, 200, { relays: [1, 0], dimmer: 80 }));
    const status = await client(fan.host).getStatus();
    expect(status).toEqual({ relays: [1, 0], dimmer: 80 });
    const [req] = fan.requests;
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/api/switch');
    expect(req.query.get('apikey')).toBe(AK);
    expect(req.query.get('meta1')).toBe(META1);
    expect(req.query.get('meta')).toBe(META);
  });

  test('setRelay posts a form-encoded relay command with signed query', async () => {
    const fan = await fakeFan((_req, res) => json(res, 200, { relays: [0, 1] }));
    const result = await client(fan.host).setRelay(2, true);
    const [req] = fan.requests;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/switch');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.body).toBe('key=2&value=1');
    expect(req.query.get('apikey')).toBe(AK);
    expect(req.query.get('meta')).toBe(META);
    expect(result).toEqual({ relays: [0, 1], dimmer: undefined });
  });

  test('setRelay off sends value=0 (firmware reads true/false as 0)', async () => {
    const fan = await fakeFan();
    await client(fan.host).setRelay(1, false);
    expect(fan.requests[0].body).toBe('key=1&value=0');
  });

  test('setDimmer posts the dimmer command', async () => {
    const fan = await fakeFan();
    await client(fan.host).setDimmer(1, 60);
    expect(fan.requests[0].body).toBe('key=1&value=60&is_dimmer=true');
  });

  test('command returns undefined when the reply has no relays', async () => {
    const fan = await fakeFan((_req, res) => text(res, 200, 'OK'));
    expect(await client(fan.host).setRelay(1, true)).toBeUndefined();
    fan.respond = (_req, res) => json(res, 200, { ok: true });
    expect(await client(fan.host).setRelay(1, true)).toBeUndefined();
  });

  test('403 rejects with FanHttpError and leaks no credentials', async () => {
    const fan = await fakeFan((_req, res) => text(res, 403, 'UNAUTHORIZED'));
    const err = await client(fan.host).getStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FanHttpError);
    expect((err as FanHttpError).status).toBe(403);
    const message = (err as Error).message;
    expect(message).not.toContain(AK);
    expect(message).not.toContain(SK);
    expect(message).not.toContain(META);
    expect(message).not.toContain('meta=');
  });

  test('unresponsive fan rejects with status 0 after the timeout', async () => {
    const fan = await fakeFan(() => {
      /* never respond */
    });
    const err = await client(fan.host, { timeoutMs: 200 }).getStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FanHttpError);
    expect((err as FanHttpError).status).toBe(0);
    expect((err as Error).message).not.toContain(AK);
  });

  test('ping is unauthenticated and returns firmware info', async () => {
    const fan = await fakeFan((_req, res) =>
      json(res, 200, {
        app: 'KIOT_FIRMWARE', version: '4.2.0', rev: 'abc', hostname: 'fan_aabbccddeeff',
        device: 'FAN', deviceId: 'aabbccddeeff', cv: 2, ssv: 2,
      }),
    );
    const info = await client(fan.host).ping();
    expect(info).toEqual({ version: '4.2.0', deviceId: 'aabbccddeeff', hostname: 'fan_aabbccddeeff' });
    const [req] = fan.requests;
    expect(req.path).toBe('/ping');
    expect(req.query.has('apikey')).toBe(false);
    expect(req.query.has('meta')).toBe(false);
  });

  test('setHost redirects later requests', async () => {
    const first = await fakeFan();
    const second = await fakeFan();
    const c = client(first.host);
    await c.getStatus();
    c.setHost(second.host);
    await c.getStatus();
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  test('requests to one fan never overlap and meta1 differs (Review Focus 1)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seenMeta1: string[] = [];
    const fan = await fakeFan(async (req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      seenMeta1.push(req.query.get('meta1') ?? '');
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      json(res, 200, { relays: [1, 0] });
    });
    const c = new FanClient({ host: fan.host, apikey: AK, apiSecret: SK }); // real clock
    await Promise.all([c.getStatus(), c.setRelay(1, true), c.getStatus()]);
    expect(maxInFlight).toBe(1);
    expect(seenMeta1).toHaveLength(3);
    expect(new Set(seenMeta1).size).toBe(3);
  });

  test('a failed request does not block the next one', async () => {
    const fan = await fakeFan((_req, res) => text(res, 500, 'boom'));
    const c = client(fan.host);
    await expect(c.getStatus()).rejects.toBeInstanceOf(FanHttpError);
    fan.respond = (_req, res) => json(res, 200, { relays: [1] });
    await expect(c.getStatus()).resolves.toEqual({ relays: [1], dimmer: undefined });
  });
});
