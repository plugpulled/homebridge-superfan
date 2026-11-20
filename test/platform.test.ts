import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformConfig } from 'homebridge';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readCache, writeCache } from '../src/cache.js';
import { CloudAuthError } from '../src/cloud/kiotCloud.js';
import { FanController } from '../src/controller.js';
import { ConfigError, loadFans, parseConfig, planAccessories, SuperfanPlatform, type PlatformDeps } from '../src/platform.js';
import type { FanRecord, FanStatus } from '../src/types.js';

const fanA: FanRecord = {
  deviceId: 'aabbccddeeff', name: 'Bedroom Fan', model: 'Superfan Smart Fan', apikey: 'ak_fake_a', apiSecret: 'sk_fake_a',
  localName: 'fan_aabbccddeeff.local', fanSwitchNo: 1, steps: 3, cloudHost: '10.0.0.5',
};
const fanB: FanRecord = { ...fanA, deviceId: '112233445566', name: 'Study Fan', apikey: 'ak_fake_b', apiSecret: 'sk_fake_b', localName: 'fan_112233445566.local', cloudHost: undefined };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superfan-platform-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function spyLog() {
  const msgs: { level: string; msg: string }[] = [];
  const at = (level: string) => vi.fn((msg: string) => {
    msgs.push({ level, msg });
  });
  const log = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), success: at('info'), log: vi.fn(), prefix: 'Superfan' };
  return { log: log as unknown as Logging & Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>, msgs };
}

describe('parseConfig', () => {
  const base = { platform: 'Superfan', email: 'me@example.com', password: ' pw ' };

  test('requires email and password, naming the missing field', () => {
    expect(() => parseConfig({ platform: 'Superfan' } as PlatformConfig)).toThrow(ConfigError);
    expect(() => parseConfig({ platform: 'Superfan' } as PlatformConfig)).toThrow(/email/);
    expect(() => parseConfig({ platform: 'Superfan', email: 'a@b.c' } as PlatformConfig)).toThrow(/password/);
  });

  test('defaults and clamps pollInterval, keeps the password as typed', () => {
    expect(parseConfig(base as PlatformConfig)).toMatchObject({ email: 'me@example.com', password: ' pw ', pollInterval: 5, devices: [] });
    expect(parseConfig({ ...base, pollInterval: 1 } as PlatformConfig).pollInterval).toBe(2);
    expect(parseConfig({ ...base, pollInterval: 1000 } as PlatformConfig).pollInterval).toBe(300);
  });

  test('normalises per-device overrides', () => {
    const cfg = parseConfig({ ...base, devices: [{ deviceId: 'AABBCCDDEEFF', host: '10.0.0.9', model: 'Superfan Super Q' }, { host: 'x' }] } as PlatformConfig);
    expect(cfg.devices).toEqual([{ deviceId: 'aabbccddeeff', host: '10.0.0.9', model: 'Superfan Super Q' }]);
  });
});

describe('loadFans', () => {
  const path = () => join(dir, 'superfan', 'cache.json');

  test('cloud success returns its fans and saves them, keeping known hosts', async () => {
    await writeCache(path(), { version: 1, fans: [fanB], lastHosts: { aabbccddeeff: '10.0.0.7' } });
    const { log } = spyLog();
    const result = await loadFans({ discover: async () => ({ fans: [fanA], skipped: [] }), cachePath: path(), log });
    expect(result).toEqual({ fans: [fanA], lastHosts: { aabbccddeeff: '10.0.0.7' } });
    expect((await readCache(path()))?.fans).toEqual([fanA]);
  });

  test('skipped fans are reported with a link to open an issue', async () => {
    const { log, msgs } = spyLog();
    await loadFans({ discover: async () => ({ fans: [], skipped: [{ name: 'Twin Fan', reason: 'unsupported switch layout' }] }), cachePath: path(), log });
    expect(msgs.some((m) => m.level === 'warn' && m.msg.includes('Twin Fan') && m.msg.includes('github.com/plugpulled/homebridge-superfan/issues'))).toBe(true);
  });

  test('bad password with a cache: cached fans, one warning, no secrets (Review Focus 4)', async () => {
    await writeCache(path(), { version: 1, fans: [fanA], lastHosts: {} });
    const { log, msgs } = spyLog();
    const discover = vi.fn(async () => {
      throw new CloudAuthError('Superfan login failed (HTTP 401)');
    });
    const result = await loadFans({ discover, cachePath: path(), log });
    expect(result.fans).toEqual([fanA]);
    expect(discover).toHaveBeenCalledTimes(1);
    const warns = msgs.filter((m) => m.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(/email\/password/);
    expect(msgs.map((m) => m.msg).join('\n')).not.toMatch(/ak_fake|sk_fake/);
  });

  test('cloud down and no cache: fans unknown, one error', async () => {
    const { log, msgs } = spyLog();
    const result = await loadFans({ discover: async () => { throw new Error('Superfan cloud unreachable'); }, cachePath: path(), log });
    expect(result.fans).toBeUndefined();
    expect(msgs.filter((m) => m.level === 'error')).toHaveLength(1);
  });
});

describe('planAccessories', () => {
  test('splits fans into create/restore and stale accessories into remove', () => {
    expect(planAccessories(['u-aabbccddeeff', 'u-x'], [fanA, fanB], (id) => `u-${id}`)).toEqual({
      create: [fanB], restore: [fanA], remove: ['u-x'],
    });
  });
});

class FakeClient {
  calls: string[] = [];
  host: string;
  constructor(o: { host: string }) {
    this.host = o.host;
  }
  async ping() {
    return { version: '4.2.0', deviceId: 'x', hostname: 'x' };
  }
  async getStatus(): Promise<FanStatus> {
    this.calls.push('getStatus');
    return { relays: [1], dimmer: 66 };
  }
  async setRelay() {
    return undefined;
  }
  async setDimmer() {
    return undefined;
  }
  setHost(h: string) {
    this.host = h;
  }
}

class FakePlatformAccessory extends hap.Accessory {
  context: Record<string, unknown> = {};
}

function fakeApi() {
  const api = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(api, {
    hap,
    user: { storagePath: () => dir },
    platformAccessory: FakePlatformAccessory,
    registerPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
  });
  return api as unknown as API & Pick<EventEmitter, 'emit'> & Record<'registerPlatformAccessories' | 'unregisterPlatformAccessories', ReturnType<typeof vi.fn>>;
}

describe('SuperfanPlatform', () => {
  const config = { platform: 'Superfan', email: 'me@example.com', password: 'hunter2-secret' } as PlatformConfig;

  function makeDeps(fans: FanRecord[] | Error, clients: FakeClient[] = []): PlatformDeps {
    return {
      discover: vi.fn(async () => {
        if (fans instanceof Error) throw fans;
        return { fans, skipped: [] };
      }),
      findFanViaMdns: vi.fn(async () => '10.0.0.8'),
      createClient: (o) => {
        const c = new FakeClient(o);
        clients.push(c);
        return c as never;
      },
    };
  }

  test('registers one accessory per new fan and starts polling it', async () => {
    const api = fakeApi();
    const clients: FakeClient[] = [];
    const platform = new SuperfanPlatform(spyLog().log, config, api, makeDeps([fanA], clients));
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1));
    const [plugin, name, accessories] = api.registerPlatformAccessories.mock.calls[0];
    expect([plugin, name]).toEqual(['homebridge-superfan', 'Superfan']);
    expect(accessories).toHaveLength(1);
    expect(accessories[0].UUID).toBe(hap.uuid.generate('superfan:aabbccddeeff'));
    expect(accessories[0].getService(hap.Service.Fanv2)).toBeDefined();
    expect(clients[0].host).toBe('10.0.0.5');
    await vi.waitFor(() => expect(clients[0].calls).toContain('getStatus'));
    api.emit('shutdown');
    void platform;
  });

  test('config host override wins over the cloud address and mDNS is not used', async () => {
    const api = fakeApi();
    const clients: FakeClient[] = [];
    const deps = makeDeps([fanA], clients);
    new SuperfanPlatform(spyLog().log, { ...config, devices: [{ deviceId: 'aabbccddeeff', host: '10.0.0.99' }] } as PlatformConfig, api, deps);
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    expect(clients[0].host).toBe('10.0.0.99');
    expect(deps.findFanViaMdns).not.toHaveBeenCalled();
    api.emit('shutdown');
  });

  test('saves the resolved host for next time', async () => {
    const api = fakeApi();
    new SuperfanPlatform(spyLog().log, config, api, makeDeps([fanB]));
    api.emit('didFinishLaunching');
    await vi.waitFor(async () => expect((await readCache(join(dir, 'superfan', 'cache.json')))?.lastHosts).toEqual({ '112233445566': '10.0.0.8' }));
    api.emit('shutdown');
  });

  test('removes cached accessories for fans no longer on the account', async () => {
    const api = fakeApi();
    const platform = new SuperfanPlatform(spyLog().log, config, api, makeDeps([fanA]));
    const stale = new FakePlatformAccessory('Old Fan', hap.uuid.generate('superfan:000000000000'));
    platform.configureAccessory(stale as never);
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith('homebridge-superfan', 'Superfan', [stale]));
    api.emit('shutdown');
  });

  test('fans unknown (cloud down, no cache) leaves cached accessories alone', async () => {
    const api = fakeApi();
    const { log, msgs } = spyLog();
    const platform = new SuperfanPlatform(log, config, api, makeDeps(new Error('Superfan cloud unreachable')));
    const cached = new FakePlatformAccessory('Bedroom Fan', hap.uuid.generate('superfan:aabbccddeeff'));
    platform.configureAccessory(cached as never);
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(msgs.some((m) => m.level === 'error')).toBe(true));
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  test('shutdown stops every fan controller', async () => {
    const stop = vi.spyOn(FanController.prototype, 'stop');
    const api = fakeApi();
    const clients: FakeClient[] = [];
    new SuperfanPlatform(spyLog().log, config, api, makeDeps([fanA, fanB], clients));
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());
    api.emit('shutdown');
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test('invalid config logs an error and does nothing else', async () => {
    const api = fakeApi();
    const { log, msgs } = spyLog();
    const deps = makeDeps([fanA]);
    new SuperfanPlatform(log, { platform: 'Superfan' } as PlatformConfig, api, deps);
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 20));
    expect(msgs.some((m) => m.level === 'error' && /email/.test(m.msg))).toBe(true);
    expect(deps.discover).not.toHaveBeenCalled();
  });

  test('an offline fan never triggers cloud logins after startup (review I1)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = fakeApi();
      const clients: FakeClient[] = [];
      const deps = makeDeps([fanA], clients);
      deps.findFanViaMdns = vi.fn(async () => undefined);
      new SuperfanPlatform(spyLog().log, config, api, deps);
      api.emit('didFinishLaunching');
      await vi.waitFor(() => expect(clients).toHaveLength(1));
      clients[0].getStatus = async () => {
        throw new Error('unreachable');
      };
      await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour offline
      expect(deps.discover).toHaveBeenCalledTimes(1); // startup only
      expect(vi.mocked(deps.findFanViaMdns).mock.calls.length).toBeGreaterThan(0); // still looks locally
      api.emit('shutdown');
    } finally {
      vi.useRealTimers();
    }
  });

  test('never logs the password or device keys', async () => {
    const api = fakeApi();
    const { log, msgs } = spyLog();
    new SuperfanPlatform(log, config, api, makeDeps([fanA, fanB]));
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(api.registerPlatformAccessories).toHaveBeenCalled());
    api.emit('shutdown');
    const all = msgs.map((m) => m.msg).join('\n');
    for (const s of ['hunter2-secret', 'ak_fake', 'sk_fake']) expect(all).not.toContain(s);
  });
});
