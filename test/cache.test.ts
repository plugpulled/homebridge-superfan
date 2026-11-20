import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readCache, writeCache } from '../src/cache.js';
import type { CacheData } from '../src/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superfan-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: CacheData = {
  version: 1,
  refreshToken: 'r1',
  fans: [{
    deviceId: 'aabbccddeeff', name: 'Bedroom Fan', model: 'Superfan Super Q', apikey: 'ak_fake', apiSecret: 'sk_fake',
    localName: 'fan_aabbccddeeff.local', fanSwitchNo: 1, steps: 5, lightSwitchNo: 2,
  }],
  lastHosts: { aabbccddeeff: '10.0.0.5' },
};

describe('cache', () => {
  test('write then read round-trips, in a new sub-directory', async () => {
    const path = join(dir, 'superfan', 'cache.json');
    await writeCache(path, sample);
    expect(await readCache(path)).toEqual(sample);
  });

  test('file is only readable by its owner and no temp file is left', async () => {
    const path = join(dir, 'superfan', 'cache.json');
    await writeCache(path, sample);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, 'superfan'))).toEqual(['cache.json']);
  });

  test('overwriting keeps 0600', async () => {
    const path = join(dir, 'cache.json');
    await writeFile(path, '{}', { mode: 0o644 });
    await writeCache(path, sample);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('missing, corrupt, or wrong-version files read as undefined', async () => {
    expect(await readCache(join(dir, 'nope.json'))).toBeUndefined();
    await writeFile(join(dir, 'bad.json'), 'not json');
    expect(await readCache(join(dir, 'bad.json'))).toBeUndefined();
    await writeFile(join(dir, 'v2.json'), JSON.stringify({ ...sample, version: 2 }));
    expect(await readCache(join(dir, 'v2.json'))).toBeUndefined();
  });
});
