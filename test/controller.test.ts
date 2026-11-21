import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FanController, OfflineError } from '../src/controller.js';
import { CloudAuthError } from '../src/cloud/kiotCloud.js';
import { FanHttpError, type FanClientLike } from '../src/local/fanClient.js';
import type { FanRecord, FanState, FanStatus, Logger } from '../src/types.js';

const fan: FanRecord = {
  deviceId: 'aabbccddeeff', name: 'Bedroom Fan', model: 'Superfan Super Q', apikey: 'ak_fake_key', apiSecret: 'sk_fake_secret',
  localName: 'fan_aabbccddeeff.local', fanSwitchNo: 1, steps: 5, lightSwitchNo: 2,
};

type Call = [string, ...unknown[]];

class FakeClient implements FanClientLike {
  calls: Call[] = [];
  statusTimes: number[] = [];
  /** What the next getStatus returns; an Error makes it reject. */
  status: FanStatus | Error = { relays: [0, 0], dimmer: 20 };
  commandError?: Error;

  async getStatus(): Promise<FanStatus> {
    this.calls.push(['getStatus']);
    this.statusTimes.push(Date.now());
    if (this.status instanceof Error) throw this.status;
    return this.status;
  }
  async setRelay(switchNo: number, on: boolean): Promise<FanStatus | undefined> {
    this.calls.push(['setRelay', switchNo, on]);
    if (this.commandError) throw this.commandError;
    return undefined;
  }
  async setDimmer(switchNo: number, value: number): Promise<FanStatus | undefined> {
    this.calls.push(['setDimmer', switchNo, value]);
    if (this.commandError) throw this.commandError;
    return undefined;
  }
  setHost(host: string): void {
    this.calls.push(['setHost', host]);
  }
  setKeys(apikey: string, apiSecret: string): void {
    this.calls.push(['setKeys', apikey, apiSecret]);
  }
  commands(): Call[] {
    return this.calls.filter((c) => c[0] !== 'getStatus');
  }
}

function spyLog(): Logger & { all: () => string[] } {
  const msgs: string[] = [];
  const rec = vi.fn((m: string) => {
    msgs.push(m);
  });
  return { debug: rec, info: vi.fn((m: string) => rec(m)), warn: vi.fn((m: string) => rec(m)), error: vi.fn((m: string) => rec(m)), all: () => msgs };
}

let client: FakeClient;
let log: ReturnType<typeof spyLog>;
let ctl: FanController;

function make(opts: {
  reresolve?: () => Promise<string | undefined>;
  refreshKeys?: () => Promise<FanRecord | undefined>;
  pollIntervalMs?: number;
  host?: string;
} = {}): FanController {
  ctl = new FanController({
    client, fan, pollIntervalMs: opts.pollIntervalMs ?? 5000, log, reresolve: opts.reresolve, refreshKeys: opts.refreshKeys, host: opts.host,
  });
  return ctl;
}

async function startWith(status: FanStatus, opts?: Parameters<typeof make>[0]): Promise<void> {
  client.status = status;
  make(opts).start();
  await vi.advanceTimersByTimeAsync(0);
  client.calls = [];
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  client = new FakeClient();
  log = spyLog();
});
afterEach(() => {
  ctl?.stop();
  vi.useRealTimers();
});

describe('polling and state', () => {
  test('polls immediately, then every pollIntervalMs', async () => {
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.statusTimes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.statusTimes).toEqual([0, 5000, 10_000]);
  });

  test('maps relays and dimmer to fan/light/speed', async () => {
    await startWith({ relays: [1, 1], dimmer: 80 });
    expect(ctl.state).toEqual({ online: true, fanOn: true, speed: 4, lightOn: true });
  });

  test("emits 'change' only when the state differs", async () => {
    const changes: FanState[] = [];
    client.status = { relays: [1, 0], dimmer: 60 };
    make().on('change', (s) => changes.push({ ...s }));
    ctl.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes).toEqual([{ online: true, fanOn: true, speed: 3, lightOn: false }]);
  });

  test('missing relay entries read as off and keep the previous speed', async () => {
    await startWith({ relays: [1], dimmer: 40 });
    client.status = { relays: [1] };
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctl.state).toMatchObject({ fanOn: true, lightOn: false, speed: 2 });
  });

  test("a reply without the fan's relay counts as a failed read, not \"off\"", async () => {
    await startWith({ relays: [1, 0], dimmer: 40 }, { pollIntervalMs: 1000 });
    client.status = { relays: [] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctl.state).toMatchObject({ online: true, fanOn: true });
    await vi.advanceTimersByTimeAsync(2000); // 3rd bad reply
    expect(ctl.state.online).toBe(false);
  });
});

describe('commands', () => {
  test('setFanOn sends the fan relay and re-reads status after 1 s', async () => {
    await startWith({ relays: [0, 0], dimmer: 20 });
    await ctl.setFanOn(true);
    expect(client.commands()).toEqual([['setRelay', 1, true]]);
    client.calls = [];
    await vi.advanceTimersByTimeAsync(999);
    expect(client.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toEqual([['getStatus']]);
  });

  test('setSpeed while on only changes the dimmer', async () => {
    await startWith({ relays: [1, 0], dimmer: 20 });
    await ctl.setSpeed(3);
    expect(client.commands()).toEqual([['setDimmer', 1, 60]]);
  });

  test('setSpeed while off sets the dimmer then turns the fan on', async () => {
    await startWith({ relays: [0, 0], dimmer: 20 });
    await ctl.setSpeed(3);
    expect(client.commands()).toEqual([['setDimmer', 1, 60], ['setRelay', 1, true]]);
    expect(ctl.state).toMatchObject({ fanOn: true, speed: 3 });
  });

  test('setSpeed(5) sends 99, setSpeed(0) only turns the fan off', async () => {
    await startWith({ relays: [1, 0], dimmer: 20 });
    await ctl.setSpeed(5);
    await ctl.setSpeed(0);
    expect(client.commands()).toEqual([['setDimmer', 1, 99], ['setRelay', 1, false]]);
  });

  test('Active + speed burst never turns fan off (Review Focus 2)', async () => {
    await startWith({ relays: [0, 0], dimmer: 20 });
    await Promise.all([ctl.setFanOn(true), ctl.setSpeed(3)]);
    const calls = client.commands();
    expect(calls).toContainEqual(['setDimmer', 1, 60]);
    expect(calls.filter((c) => c[0] === 'setRelay' && c[1] === 1 && c[2] === false)).toHaveLength(0);
    expect(calls.filter((c) => c[0] === 'setRelay' && c[1] === 1 && c[2] === true).length).toBeLessThanOrEqual(1);
    expect(ctl.state).toMatchObject({ fanOn: true, speed: 3 });
  });

  test('burst in the other order also ends on at speed 3', async () => {
    await startWith({ relays: [0, 0], dimmer: 20 });
    await Promise.all([ctl.setSpeed(3), ctl.setFanOn(true)]);
    const calls = client.commands();
    expect(calls.filter((c) => c[0] === 'setRelay' && c[1] === 1 && c[2] === true).length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c[0] === 'setRelay' && c[2] === false)).toHaveLength(0);
    expect(ctl.state).toMatchObject({ fanOn: true, speed: 3 });
  });

  test('"turn on" is sent even when the cached state already says on (review M1)', async () => {
    // Poll saw the fan on; the remote has since switched it off; Siri says "turn on the fan".
    await startWith({ relays: [1, 0], dimmer: 60 });
    await ctl.setFanOn(true);
    expect(client.commands()).toEqual([['setRelay', 1, true]]);
  });

  test('a poll queued behind a speed command cannot flash the tile off (review I3)', async () => {
    // Serialised like the real FanClient: one request at a time, 300 ms each.
    // Like the real fan, a dimmer command does not switch the relay on immediately.
    const fanState = { relay: 0, dimmer: 20 };
    let chain: Promise<unknown> = Promise.resolve();
    const queued = <T>(op: () => T): Promise<T> => {
      const run = chain.then(() => new Promise<T>((r) => setTimeout(() => r(op()), 300)));
      chain = run.catch(() => undefined);
      return run;
    };
    client.getStatus = () => queued(() => ({ relays: [fanState.relay, 0], dimmer: fanState.dimmer }));
    client.setDimmer = (_n: number, v: number) => queued(() => {
      fanState.dimmer = v;
      return undefined;
    });
    client.setRelay = (_n: number, on: boolean) => queued(() => {
      fanState.relay = on ? 1 : 0;
      return undefined;
    });
    make().start();
    await vi.advanceTimersByTimeAsync(400); // first poll done: fan off
    const fanOnEvents: boolean[] = [];
    ctl.on('change', (s) => fanOnEvents.push(s.fanOn));
    await vi.advanceTimersByTimeAsync(4700); // t=5100; next poll fires at 5300
    const cmd = ctl.setSpeed(2); // dimmer runs 5100-5400; the 5300 poll queues behind it, ahead of relay-on
    await vi.advanceTimersByTimeAsync(3000);
    await cmd;
    expect(fanOnEvents).not.toContain(false);
    expect(ctl.state.fanOn).toBe(true);
  });

  test('a poll that started before a command cannot flip the optimistic state back', async () => {
    const changes: FanState[] = [];
    await startWith({ relays: [0, 0], dimmer: 20 });
    ctl.on('change', (s) => changes.push({ ...s }));
    // Poll returns the stale "off" state while the command is being sent.
    let releasePoll!: () => void;
    client.getStatus = vi.fn(async () => {
      await new Promise<void>((r) => (releasePoll = r));
      return { relays: [0, 0], dimmer: 20 };
    });
    await vi.advanceTimersByTimeAsync(5000); // poll starts and hangs
    const cmd = ctl.setFanOn(true);
    releasePoll();
    await cmd;
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.map((c) => c.fanOn)).toEqual([true]);
  });

  test('light while spinning only touches light (Review Focus 5)', async () => {
    await startWith({ relays: [1, 0], dimmer: 60 });
    client.status = { relays: [1, 0], dimmer: 60 }; // fan ignores the light while spinning
    await ctl.setLight(true);
    expect(client.commands().filter((c) => c[1] === fan.fanSwitchNo)).toHaveLength(0);
    expect(client.commands()).toContainEqual(['setRelay', 2, true]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctl.state.lightOn).toBe(false);
    expect(ctl.state.fanOn).toBe(true);
  });

  test('light on a fan without a light does nothing', async () => {
    ctl = new FanController({ client, fan: { ...fan, lightSwitchNo: undefined }, pollIntervalMs: 5000, log });
    client.status = { relays: [0] };
    ctl.start();
    await vi.advanceTimersByTimeAsync(0);
    client.calls = [];
    await ctl.setLight(true);
    expect(client.commands()).toEqual([]);
  });

  test('a failed command rejects with its error and re-reads the real state', async () => {
    await startWith({ relays: [0, 0], dimmer: 20 });
    const boom = new Error('boom');
    client.commandError = boom;
    await expect(ctl.setFanOn(true)).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.calls.at(-1)).toEqual(['getStatus']);
    expect(ctl.state.fanOn).toBe(false);
  });

  test('a failed command puts the tile back right away', async () => {
    await startWith({ relays: [0, 0], dimmer: 20 });
    const changes: FanState[] = [];
    ctl.on('change', (s) => changes.push({ ...s }));
    client.commandError = new Error('boom');
    await expect(ctl.setSpeed(3)).rejects.toThrow('boom');
    expect(ctl.state).toMatchObject({ fanOn: false, speed: 1 });
    expect(changes.at(-1)).toMatchObject({ fanOn: false, speed: 1 });
  });

  test('a failed command does not undo a newer one', async () => {
    await startWith({ relays: [0, 0], dimmer: 20 });
    client.commandError = new Error('boom');
    const first = ctl.setFanOn(true);
    client.commandError = undefined;
    const second = ctl.setSpeed(3);
    await expect(first).rejects.toThrow('boom');
    await second;
    expect(ctl.state).toMatchObject({ fanOn: true, speed: 3 });
  });
});

describe('offline handling', () => {
  test('goes offline after 3 failed polls, warns once, and rejects commands', async () => {
    const changes: FanState[] = [];
    client.status = new Error('unreachable');
    make({ pollIntervalMs: 1000 }).on('change', (s) => changes.push({ ...s }));
    ctl.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctl.state.online).toBe(true); // 2 failures so far
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctl.state.online).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changes.filter((c) => c.online === false)).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);

    client.calls = [];
    await expect(ctl.setFanOn(true)).rejects.toBeInstanceOf(OfflineError);
    await expect(ctl.setSpeed(2)).rejects.toBeInstanceOf(OfflineError);
    await expect(ctl.setLight(true)).rejects.toBeInstanceOf(OfflineError);
    expect(client.commands()).toEqual([]);
  });

  test('backs off while offline, capped at 30 s, and recovers on the first success', async () => {
    client.status = new Error('unreachable');
    make({ pollIntervalMs: 1000 }).start();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(client.statusTimes).toEqual([0, 1000, 2000, 4000, 8000, 16_000, 32_000, 62_000]);

    client.status = { relays: [1, 0], dimmer: 40 };
    client.statusTimes = [];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctl.state.online).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.statusTimes).toEqual([92_000, 93_000, 94_000]);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  test('re-resolves host after failures (Review Focus 3)', async () => {
    const reresolve = vi.fn(async () => '10.0.0.9');
    client.status = new Error('unreachable');
    make({ pollIntervalMs: 1000, reresolve }).start();
    await vi.advanceTimersByTimeAsync(2000); // 3rd failure
    expect(reresolve).toHaveBeenCalledTimes(1);
    expect(client.calls).toContainEqual(['setHost', '10.0.0.9']);
    await vi.advanceTimersByTimeAsync(4 * 60_000); // more failures within 5 minutes
    expect(reresolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(reresolve).toHaveBeenCalledTimes(2);
  });

  test('re-resolve finding nothing leaves the host alone', async () => {
    client.status = new Error('unreachable');
    make({ pollIntervalMs: 1000, reresolve: async () => undefined }).start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.calls.filter((c) => c[0] === 'setHost')).toEqual([]);
  });
});

describe('key refresh (re-added fan)', () => {
  const denied = new FanHttpError(403, 'denied');
  const timeout = new FanHttpError(0, 'timeout');
  const newKeys: FanRecord = { ...fan, apikey: 'ak_new', apiSecret: 'sk_new' };
  const HOUR = 60 * 60_000;
  const deferred = () => {
    let resolve!: (r: FanRecord | undefined) => void;
    const refreshKeys = vi.fn(() => new Promise<FanRecord | undefined>((r) => (resolve = r)));
    return { refreshKeys, resolve: (r: FanRecord | undefined) => resolve(r) };
  };
  const swaps = () => client.calls.filter((c) => c[0] === 'setKeys');
  const lines = (re: RegExp) => log.all().filter((m) => re.test(m));

  test('three 403s in a row fetch new keys once and the fan recovers without restart', async () => {
    const refreshKeys = vi.fn(async () => newKeys);
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    expect(client.calls).toContainEqual(['setKeys', 'ak_new', 'sk_new']);
    client.status = { relays: [1, 0], dimmer: 40 };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctl.state.online).toBe(true);
    expect(log.all().join('\n')).toMatch(/picked up new keys/);
    expect(log.all().join('\n')).not.toMatch(/ak_new|sk_new|ak_fake|sk_fake/);
  });

  test('a single 403 does not fetch keys', async () => {
    const refreshKeys = vi.fn(async () => newKeys);
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(0);
    client.status = { relays: [1, 0], dimmer: 40 };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshKeys).not.toHaveBeenCalled();
  });

  test('an unplugged fan (timeouts) never fetches keys', async () => {
    const refreshKeys = vi.fn(async () => newKeys);
    client.status = timeout;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(refreshKeys).not.toHaveBeenCalled();
  });

  test('403 then timeout: only the latest failure counts (Review Focus 1)', async () => {
    const refreshKeys = vi.fn(async () => newKeys);
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(1000); // two 403s
    client.status = timeout;
    await vi.advanceTimersByTimeAsync(1000); // 3rd failure is a timeout
    expect(ctl.state.online).toBe(false);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(refreshKeys).not.toHaveBeenCalled();
  });

  test('same keys: one clock warning, then no more refreshes until restart', async () => {
    const refreshKeys = vi.fn(async () => fan);
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    expect(swaps()).toEqual([]);
    expect(lines(/clock/)).toHaveLength(1);
  });

  test('fan no longer on the account behaves like same keys', async () => {
    const refreshKeys = vi.fn(async () => undefined);
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    expect(lines(/clock/)).toHaveLength(1);
  });

  test('wrong password: one warning, then no more refreshes', async () => {
    const refreshKeys = vi.fn(async (): Promise<FanRecord | undefined> => {
      throw new CloudAuthError('Superfan login failed (HTTP 401)');
    });
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    expect(lines(/email\/password/)).toHaveLength(1);
  });

  test('cloud trouble retries no sooner than 30 minutes', async () => {
    const refreshKeys = vi.fn(async (): Promise<FanRecord | undefined> => {
      throw new Error('HTTP 500');
    });
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(refreshKeys).toHaveBeenCalledTimes(2);
  });

  test('a refresh that finishes after the fan recovered changes nothing (Review Focus 2)', async () => {
    const { refreshKeys, resolve } = deferred();
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    client.status = { relays: [1, 0], dimmer: 40 };
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctl.state.online).toBe(true);
    resolve(newKeys);
    await vi.advanceTimersByTimeAsync(0);
    expect(swaps()).toEqual([]);
    expect(lines(/new keys/)).toEqual([]);
  });

  test('stop() during a refresh: no key swap, no log (Review Focus 3)', async () => {
    const { refreshKeys, resolve } = deferred();
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    ctl.stop();
    resolve(newKeys);
    await vi.advanceTimersByTimeAsync(0);
    expect(swaps()).toEqual([]);
    expect(lines(/new keys/)).toEqual([]);
  });

  test('a 403 from a moved fan looks it up locally instead of fetching keys (review I1: IP swap)', async () => {
    const refreshKeys = vi.fn(async () => newKeys);
    const reresolve = vi.fn(async () => '10.0.0.9');
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys, reresolve, host: '10.0.0.5' }).start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.calls).toContainEqual(['setHost', '10.0.0.9']);
    expect(refreshKeys).not.toHaveBeenCalled();
  });

  test('a local lookup finding the same address still fetches keys (review I1)', async () => {
    const refreshKeys = vi.fn(async () => newKeys);
    const reresolve = vi.fn(async () => '10.0.0.5');
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys, reresolve, host: '10.0.0.5' }).start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reresolve).toHaveBeenCalledTimes(1);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
  });

  test('local lookups keep running after the refresh has stopped (review I1)', async () => {
    const refreshKeys = vi.fn(async () => fan); // same keys -> refresh stops
    const reresolve = vi.fn(async () => '10.0.0.5');
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys, reresolve, host: '10.0.0.5' }).start();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    expect(reresolve.mock.calls.length).toBeGreaterThanOrEqual(3); // at ~2 s, ~5 min, ~10 min
  });

  test('one 403 after timeouts does not fetch keys (review M1: power cut, then a one-off rejection)', async () => {
    const refreshKeys = vi.fn(async () => newKeys);
    client.status = timeout;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(2000); // three timeouts: offline
    client.status = denied;
    await vi.advanceTimersByTimeAsync(2000); // one 403
    client.status = { relays: [1, 0], dimmer: 40 };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctl.state.online).toBe(true);
    expect(refreshKeys).not.toHaveBeenCalled();
    expect(lines(/clock/)).toEqual([]);
  });

  test('a refresh discarded because the fan recovered still waits 30 minutes before the next (review M2)', async () => {
    const { refreshKeys, resolve } = deferred();
    client.status = denied;
    make({ pollIntervalMs: 1000, refreshKeys }).start();
    await vi.advanceTimersByTimeAsync(2000);
    client.status = { relays: [1, 0], dimmer: 40 };
    await vi.advanceTimersByTimeAsync(2000);
    resolve(newKeys); // discarded: the fan is back
    await vi.advanceTimersByTimeAsync(0);
    client.status = denied;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshKeys).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(refreshKeys).toHaveBeenCalledTimes(2);
  });
});

describe('lifecycle and logging', () => {
  test('stop() ends polling', async () => {
    await startWith({ relays: [0, 0] });
    ctl.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.calls).toEqual([]);
  });

  test('never logs device keys', async () => {
    client.status = new Error('unreachable');
    make({ pollIntervalMs: 1000, reresolve: async () => '10.0.0.9' }).start();
    await vi.advanceTimersByTimeAsync(10_000);
    client.status = { relays: [1, 0] };
    await vi.advanceTimersByTimeAsync(30_000);
    const all = log.all().join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(fan.apikey);
    expect(all).not.toContain(fan.apiSecret);
  });
});
