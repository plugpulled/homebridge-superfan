import { describe, expect, test, vi } from 'vitest';
import { CloudAuthError, KiotCloud } from '../src/cloud/kiotCloud.js';
import homes from './fixtures/homes.json' with { type: 'json' };
import ips from './fixtures/ips.json' with { type: 'json' };
import mydevices from './fixtures/mydevices.json' with { type: 'json' };

interface Seen { url: string; method: string; headers: Record<string, string>; body?: unknown }

function fakeFetch(reply: (seen: Seen) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const seen: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(seen);
    const { status, body } = reply(seen);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('KiotCloud.login', () => {
  test('posts the app login payload to the auth base (no /api/v1)', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { token: 'tok_1', refresh_token: 'ref_1', user: { _id: 'u1' } } }));
    const session = await new KiotCloud({ fetchImpl: f.impl }).login('me@example.com', ' p@ss ');
    expect(session).toEqual({ token: 'tok_1' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.kiot.io/user/authenticate_v2');
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].headers['content-type']).toBe('application/json');
    expect(f.calls[0].headers.authorization).toBeUndefined();
    expect(f.calls[0].body).toEqual({
      email: 'me@example.com', password: ' p@ss ', loginType: 'password', partner: '64183d9c85be48b30615fac4',
    });
  });

  test.each([400, 401, 403])('HTTP %i rejects with CloudAuthError that never contains the password', async (status) => {
    const f = fakeFetch(() => ({ status, body: { app: 'kiot', head: null, message: 'Invalid credentials' } }));
    const err = await new KiotCloud({ fetchImpl: f.impl }).login('me@example.com', 'hunter2-secret').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudAuthError);
    expect((err as Error).message).not.toContain('hunter2-secret');
  });

  test('200 without a token is treated as a login failure', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { user: {} } }));
    await expect(new KiotCloud({ fetchImpl: f.impl }).login('a@b.c', 'x')).rejects.toBeInstanceOf(CloudAuthError);
  });

  test('server errors are plain errors, not auth errors', async () => {
    const f = fakeFetch(() => ({ status: 503, body: {} }));
    const err = await new KiotCloud({ fetchImpl: f.impl }).login('a@b.c', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CloudAuthError);
  });
});

describe('KiotCloud data endpoints', () => {
  const routes = (seen: Seen) => {
    if (seen.url.includes('homes/myhomes')) return { status: 200, body: homes };
    if (seen.url.includes('userdevices/mydevices')) return { status: 200, body: mydevices };
    if (seen.url.includes('userdevices/get_ips')) return { status: 200, body: ips };
    return { status: 404, body: {} };
  };

  test('use /api/v1 with the bearer token', async () => {
    const f = fakeFetch(routes);
    const cloud = new KiotCloud({ fetchImpl: f.impl });
    expect(await cloud.getHomeIds('tok_1')).toEqual(['h00000000000000000000001']);
    expect(await cloud.getDevices('tok_1', 'h1')).toEqual(mydevices);
    expect(await cloud.getIps('tok_1', 'h1')).toEqual(ips);
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://api.kiot.io/api/v1/homes/myhomes?only_ids=true',
      'https://api.kiot.io/api/v1/userdevices/mydevices?home=h1&append=room,swappliance,kiotdevice',
      'https://api.kiot.io/api/v1/userdevices/get_ips?home_id=h1',
    ]);
    for (const c of f.calls) expect(c.headers.authorization).toBe('Bearer tok_1');
  });

  test('unexpected reply shapes are errors, not "no fans" (review I2)', async () => {
    const odd = fakeFetch((seen) => ({ status: 200, body: seen.url.includes('homes') ? { data: [{ _id: 'h1' }] } : {} }));
    const cloud = new KiotCloud({ fetchImpl: odd.impl });
    await expect(cloud.getHomeIds('tok_1')).rejects.toThrow(/unexpected/i);
    await expect(cloud.getDevices('tok_1', 'h1')).rejects.toThrow(/unexpected/i);
  });

  test('a failed data call rejects with the HTTP status and no token in the message', async () => {
    const f = fakeFetch(() => ({ status: 500, body: {} }));
    const err = await new KiotCloud({ fetchImpl: f.impl }).getHomeIds('tok_secret_1').catch((e: unknown) => e);
    expect((err as Error).message).toContain('500');
    expect((err as Error).message).not.toContain('tok_secret_1');
  });
});
