import { describe, expect, test, vi } from 'vitest';
import { matchesFan, resolveHost } from '../src/local/discovery.js';

describe('matchesFan', () => {
  test('matches the fan_<deviceId> instance name', () => {
    expect(matchesFan('fan_aabbccddeeff', 'aabbccddeeff')).toBe(true);
  });
  test('ignores case and mDNS conflict suffixes', () => {
    expect(matchesFan('FAN_AABBCCDDEEFF (2)', 'aabbccddeeff')).toBe(true);
  });
  test('rejects other fans', () => {
    expect(matchesFan('fan_112233445566', 'aabbccddeeff')).toBe(false);
    expect(matchesFan('fan_aabbccddeeff00', 'aabbccddeeff')).toBe(false);
  });
});

describe('resolveHost', () => {
  const mdnsFound = () => vi.fn(async () => '10.0.0.3');

  test('config override wins and mDNS is not tried', async () => {
    const mdns = mdnsFound();
    expect(await resolveHost({ override: '10.0.0.1', cloudHost: '10.0.0.2', lastHost: '10.0.0.4', mdns })).toBe('10.0.0.1');
    expect(mdns).not.toHaveBeenCalled();
  });

  test('cloud address is next and mDNS is not tried', async () => {
    const mdns = mdnsFound();
    expect(await resolveHost({ cloudHost: '10.0.0.2', lastHost: '10.0.0.4', mdns })).toBe('10.0.0.2');
    expect(mdns).not.toHaveBeenCalled();
  });

  test('mDNS is tried once when there is no override or cloud address', async () => {
    const mdns = mdnsFound();
    expect(await resolveHost({ lastHost: '10.0.0.4', mdns })).toBe('10.0.0.3');
    expect(mdns).toHaveBeenCalledTimes(1);
  });

  test('falls back to the last known host, then undefined', async () => {
    const none = vi.fn(async () => undefined);
    expect(await resolveHost({ lastHost: '10.0.0.4', mdns: none })).toBe('10.0.0.4');
    expect(await resolveHost({ mdns: none })).toBeUndefined();
  });
});

describe('findFanViaMdns', () => {
  test('an mDNS socket error resolves undefined instead of crashing (review I4)', async () => {
    const { EventEmitter } = await import('node:events');
    const { findFanViaMdns } = await import('../src/local/discovery.js');
    const mdns = new EventEmitter();
    let destroyed = false;
    const fake = {
      server: { mdns },
      find: () => {
        setTimeout(() => mdns.emit('error', Object.assign(new Error('bind EADDRINUSE'), { code: 'EADDRINUSE' })), 5);
        return {};
      },
      destroy: () => {
        destroyed = true;
      },
    };
    await expect(findFanViaMdns('aabbccddeeff', 2000, () => fake as never)).resolves.toBeUndefined();
    expect(destroyed).toBe(true);
  });
});
