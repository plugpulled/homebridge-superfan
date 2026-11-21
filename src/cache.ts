import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CacheData } from './types.js';

/** Read the discovery cache. Missing, unreadable, or unknown-version files yield `undefined`. */
export async function readCache(path: string): Promise<CacheData | undefined> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as Partial<CacheData>;
    if (data?.version !== 1 || !Array.isArray(data.fans)) {
      return undefined;
    }
    return { version: 1, fans: data.fans, lastHosts: data.lastHosts ?? {} };
  } catch {
    return undefined;
  }
}

/** Atomically write the cache with owner-only permissions (it holds device keys). */
export async function writeCache(path: string, data: CacheData): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
