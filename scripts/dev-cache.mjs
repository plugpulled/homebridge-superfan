#!/usr/bin/env node
// Dev-only: turn the probe's raw responses (.dev/raw) into a plugin-format cache (.dev/cache.json, mode 0600).
// Prints fan names and layout only — never keys. Requires `pnpm build` first.
// Usage: node scripts/dev-cache.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCache } from '../dist/cache.js';
import { extractFans, normaliseLocalName } from '../dist/cloud/extractFans.js';

const DEV = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev');
const RAW = join(DEV, 'raw');
const read = (name) => JSON.parse(readFileSync(join(RAW, name), 'utf8'));

const files = readdirSync(RAW);
const ips = Object.fromEntries(
  files.filter((f) => f.startsWith('ips-')).flatMap((f) => Object.entries(read(f)).map(([k, v]) => [normaliseLocalName(k), v])),
);
const fans = [];
const skipped = [];
for (const f of files.filter((n) => n.startsWith('mydevices-'))) {
  const found = extractFans(read(f));
  skipped.push(...found.skipped);
  for (const fan of found.fans) fans.push(ips[fan.localName] ? { ...fan, cloudHost: ips[fan.localName] } : fan);
}

await writeCache(join(DEV, 'cache.json'), { version: 1, fans, lastHosts: {} });
console.log(`${fans.length} fan(s): ${fans.map((f) => `${f.name} [steps ${f.steps}, light ${f.lightSwitchNo ? 'yes' : 'no'}, cloud IP ${f.cloudHost ? 'yes' : 'no'}]`).join('; ')}`);
if (skipped.length) console.log(`skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`);
