#!/usr/bin/env node
// Dev-only probe of the Superfan (KIOT) cloud API.
// Asks for your Superfan email + password (hidden), fetches homes, devices and local IPs,
// and writes:
//   .dev/raw/*.json     full responses (mode 0600, access token removed) — never share these
//   .dev/shapes.json    structure only, secrets and most values redacted — safe to inspect
// Usage: node scripts/probe-cloud.mjs
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const BASE = 'https://api.kiot.io/api/v1/'; // logged-in endpoints; keep in sync with src/settings.ts
const AUTH_BASE = 'https://api.kiot.io/'; // login/sign-up endpoints have no /api/v1 prefix
const PARTNER_ID = '64183d9c85be48b30615fac4'; // keep in sync with src/settings.ts
const DEV_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev');
const RAW_DIR = join(DEV_DIR, 'raw');

const ALWAYS_REDACT = /token|secret|apikey|api_key|password|encrypt|email|phone|mobile|ssid|pass|mac/i;
const KEEP_STRING_KEYS = new Set(['switch_type', 'name', 'type', 'dev_type', 'model', 'product_name', 'product_type', 'feature_type']);

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      // The app sends the password exactly as typed; only trim visible input like the email.
      resolve(hidden ? answer : answer.trim());
    });
  });
}

async function call(method, path, token, body, base = BASE) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  console.log(`${method} ${path.split('?')[0]} -> ${res.status}`);
  return { status: res.status, data };
}

function shape(value, key = '', inFeature = false) {
  if (key && ALWAYS_REDACT.test(key)) return '<redacted>';
  if (Array.isArray(value)) {
    const items = value.slice(0, 3).map((v) => shape(v, '', inFeature || key === 'feature'));
    return value.length > 3 ? [...items, `<len ${value.length}>`] : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k, inFeature)]));
  }
  if (typeof value === 'string') {
    return KEEP_STRING_KEYS.has(key) || inFeature ? value : `<string len ${value.length}>`;
  }
  return value;
}

/** Like shape() but keeps string values (for non-personal product metadata); secret-looking keys still redacted. */
function keepStrings(value, key = '') {
  if (key && ALWAYS_REDACT.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((v) => keepStrings(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keepStrings(v, k)]));
  return value;
}

function findHomeIds(homesData, loginData) {
  const ids = new Set();
  const visit = (v, k) => {
    if (typeof v === 'string' && /^[a-f0-9]{24}$/.test(v) && (k === '_id' || k === '' || k === 'home_id')) ids.add(v);
    else if (Array.isArray(v)) v.forEach((x) => visit(x, ''));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([kk, vv]) => visit(vv, kk));
  };
  visit(homesData, '');
  const def = loginData?.user?.default_home;
  if (typeof def === 'string') ids.add(def);
  return [...ids];
}

async function save(name, data) {
  const file = join(RAW_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}

const email = await ask('Superfan email: ');
const password = await ask('Superfan password: ', true);

await mkdir(RAW_DIR, { recursive: true, mode: 0o700 });
await chmod(DEV_DIR, 0o700);
await chmod(RAW_DIR, 0o700);

const shapes = {};
// Same pre-check the app's login screen does before showing the password field.
const exists = await call('POST', 'user/authenticate/userExists', null, { partner: PARTNER_ID, input: email }, AUTH_BASE);
console.log(`  account found for Superfan: ${exists.data?.success === 1 ? 'yes' : `no (success=${JSON.stringify(exists.data?.success)})`}`);
shapes.userExists = { status: exists.status, body: shape(exists.data) };

const login = await call('POST', 'user/authenticate_v2', null, { email, password, loginType: 'password', partner: PARTNER_ID }, AUTH_BASE);
shapes.login = { status: login.status, body: shape(login.data) };
if (login.status !== 200 || typeof login.data?.token !== 'string') {
  // Server error text only; never echo it if it somehow contains the password.
  const serverText = [login.data?.head, login.data?.message, login.data?.err].filter((x) => typeof x === 'string').join(' | ');
  console.log(`  server says: ${serverText && !serverText.includes(password) ? serverText : '(no message)'}`);
  await writeFile(join(DEV_DIR, 'shapes.json'), JSON.stringify(shapes, null, 2), { mode: 0o600 });
  console.log('Login failed; wrote .dev/shapes.json');
  process.exit(1);
}
const token = login.data.token;
const loginWithoutAccessToken = { ...login.data };
delete loginWithoutAccessToken.token;
await save('login', loginWithoutAccessToken);

const homes = await call('GET', 'homes/myhomes?only_ids=true', token);
await save('homes', homes.data);
shapes.homes = { status: homes.status, body: shape(homes.data) };

const homeIds = findHomeIds(homes.data, login.data);
shapes.homeIdCount = homeIds.length;
shapes.mydevices = {};
shapes.ips = {};
for (const [i, homeId] of homeIds.entries()) {
  const devices = await call('GET', `userdevices/mydevices?home=${homeId}&append=room,swappliance,kiotdevice`, token);
  await save(`mydevices-${homeId}`, devices.data);
  shapes.mydevices[`home${i}`] = { status: devices.status, body: shape(devices.data) };
  const ips = await call('GET', `userdevices/get_ips?home_id=${homeId}`, token);
  await save(`ips-${homeId}`, ips.data);
  shapes.ips[`home${i}`] = { status: ips.status, body: shape(ips.data) };

  // Per-device custom commands (fan modes, timer, light, ...). Product metadata, so strings are kept.
  shapes.customCommands = shapes.customCommands ?? {};
  const deviceList = (devices.data?.rooms ?? []).flatMap((r) => r.devices ?? []);
  for (const [j, dev] of deviceList.entries()) {
    if (!dev?.kd_id) continue;
    const cmds = await call('GET', `userdevices/custom_commands?kd_id=${dev.kd_id}`, token);
    await save(`custom_commands-${dev.kd_id}`, cmds.data);
    shapes.customCommands[`home${i}-device${j}`] = { status: cmds.status, body: keepStrings(cmds.data) };
  }
}

await writeFile(join(DEV_DIR, 'shapes.json'), JSON.stringify(shapes, null, 2), { mode: 0o600 });
console.log('wrote .dev/shapes.json');
