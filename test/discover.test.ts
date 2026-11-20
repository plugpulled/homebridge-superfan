import { describe, expect, test, vi } from 'vitest';
import { discoverFromCloud } from '../src/cloud/discover.js';
import { CloudAuthError, type KiotCloud } from '../src/cloud/kiotCloud.js';
import type { Logger } from '../src/types.js';
import ips from './fixtures/ips.json' with { type: 'json' };
import mydevices from './fixtures/mydevices.json' with { type: 'json' };

const creds = { email: 'me@example.com', password: 'hunter2-secret' };

function fakeCloud(overrides: Partial<Record<keyof KiotCloud, unknown>> = {}) {
  return {
    login: vi.fn(async () => ({ token: 'tok_secret_1' })),
    getHomeIds: vi.fn(async () => ['h1']),
    getDevices: vi.fn(async () => mydevices),
    getIps: vi.fn(async () => ips),
    ...overrides,
  } as unknown as KiotCloud & Record<string, ReturnType<typeof vi.fn>>;
}

function spyLog() {
  const msgs: string[] = [];
  const rec = (m: string) => {
    msgs.push(m);
  };
  const log: Logger = { debug: rec, info: rec, warn: rec, error: rec };
  return { log, msgs };
}

describe('discoverFromCloud', () => {
  test('logs in once and returns fans with cloud-reported IPs', async () => {
    const cloud = fakeCloud();
    const { log } = spyLog();
    const result = await discoverFromCloud(cloud, creds, log);
    expect(cloud.login).toHaveBeenCalledTimes(1);
    expect(cloud.login).toHaveBeenCalledWith('me@example.com', 'hunter2-secret');
    expect(cloud.getDevices).toHaveBeenCalledWith('tok_secret_1', 'h1');
    const byId = Object.fromEntries(result.fans.map((f) => [f.deviceId, f]));
    expect(byId.aabbccddeeff.cloudHost).toBe('10.0.0.5'); // key had a trailing dot
    expect(byId['112233445566'].cloudHost).toBe('10.0.0.6');
    expect(result.skipped.map((s) => s.name)).toEqual(['Twin Fan']);
  });

  test('collects fans from every home', async () => {
    const cloud = fakeCloud({ getHomeIds: vi.fn(async () => ['h1', 'h2']) });
    const result = await discoverFromCloud(cloud, creds, spyLog().log);
    expect(cloud.getDevices).toHaveBeenCalledTimes(2);
    // same fixture in both homes -> each fan only once
    expect(result.fans.filter((f) => f.deviceId === 'aabbccddeeff')).toHaveLength(1);
  });

  test('a bad password rejects with CloudAuthError after exactly one login (Review Focus 4)', async () => {
    const cloud = fakeCloud({ login: vi.fn(async () => { throw new CloudAuthError('Superfan login failed (HTTP 401)'); }) });
    await expect(discoverFromCloud(cloud, creds, spyLog().log)).rejects.toBeInstanceOf(CloudAuthError);
    expect(cloud.login).toHaveBeenCalledTimes(1);
    expect(cloud.getHomeIds).not.toHaveBeenCalled();
  });

  test('a failed IP lookup still returns fans, without cloud hosts', async () => {
    const cloud = fakeCloud({ getIps: vi.fn(async () => { throw new Error('HTTP 500'); }) });
    const result = await discoverFromCloud(cloud, creds, spyLog().log);
    expect(result.fans.length).toBe(2);
    expect(result.fans.every((f) => f.cloudHost === undefined)).toBe(true);
  });

  test('never logs credentials, token, or device keys', async () => {
    const { log, msgs } = spyLog();
    await discoverFromCloud(fakeCloud({ getIps: vi.fn(async () => { throw new Error('HTTP 500'); }) }), creds, log);
    await discoverFromCloud(fakeCloud(), creds, log);
    const all = msgs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of ['hunter2-secret', 'tok_secret_1', 'ak_fake_', 'sk_fake_', 'mp_fake']) {
      expect(all).not.toContain(secret);
    }
  });
});
