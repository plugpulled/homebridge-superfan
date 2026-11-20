#!/usr/bin/env node
// Dev-only manual control of the real fan through the plugin's local client. Never prints keys.
// Requires `pnpm build` and .dev/cache.json (from scripts/dev-cache.mjs).
// Usage: node scripts/try-fan.mjs <status | ping | fan on | fan off | speed N | dimmer V>
//   speed N  : speed step 1..steps (uses the fan's dimming_steps)
//   dimmer V : raw dimmer value 0..99 (for finding how many physical speeds the fan has)
// Env: FAN_HOST overrides the fan address.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCache } from '../dist/cache.js';
import { FanClient } from '../dist/local/fanClient.js';
import { toDimm } from '../dist/speed.js';

const cache = await readCache(join(dirname(fileURLToPath(import.meta.url)), '..', '.dev', 'cache.json'));
const fan = cache?.fans?.[0];
if (!fan) {
  console.error('No fan in .dev/cache.json — run scripts/dev-cache.mjs first');
  process.exit(1);
}
const host = process.env.FAN_HOST ?? fan.cloudHost;
const client = new FanClient({ host, apikey: fan.apikey, apiSecret: fan.apiSecret });
const [cmd, arg] = process.argv.slice(2);

let reply;
if (cmd === 'status') reply = await client.getStatus();
else if (cmd === 'ping') reply = await client.ping();
else if (cmd === 'fan' && (arg === 'on' || arg === 'off')) reply = await client.setRelay(fan.fanSwitchNo, arg === 'on');
else if (cmd === 'speed' && Number(arg) >= 1 && Number(arg) <= fan.steps) reply = await client.setDimmer(fan.fanSwitchNo, toDimm(Number(arg), fan.steps));
else if (cmd === 'dimmer' && Number(arg) >= 0 && Number(arg) <= 99) reply = await client.setDimmer(fan.fanSwitchNo, Number(arg));
else {
  console.error(`Usage: node scripts/try-fan.mjs <status | ping | fan on | fan off | speed 1..${fan.steps} | dimmer 0..99>`);
  process.exit(1);
}
console.log(`${cmd}${arg ? ` ${arg}` : ''} -> ${reply === undefined ? '(no status in reply)' : JSON.stringify(reply)}`);
if (cmd !== 'status' && cmd !== 'ping') {
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`status 1s later -> ${JSON.stringify(await client.getStatus())}`);
}
