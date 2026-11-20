import type { FanRecord, Logger } from '../types.js';
import { extractFans, normaliseLocalName, type SkippedFan } from './extractFans.js';
import type { KiotCloud } from './kiotCloud.js';

export interface Credentials {
  email: string;
  password: string;
}

export interface Discovery {
  fans: FanRecord[];
  skipped: SkippedFan[];
}

/** Log in once and collect every supported fan (with keys and cloud-reported IP) across the account's homes. */
export async function discoverFromCloud(cloud: KiotCloud, creds: Credentials, log: Logger): Promise<Discovery> {
  const { token } = await cloud.login(creds.email, creds.password);
  const homeIds = await cloud.getHomeIds(token);

  const byId = new Map<string, FanRecord>();
  const skipped = new Map<string, SkippedFan>();
  for (const homeId of homeIds) {
    const found = extractFans(await cloud.getDevices(token, homeId));
    let ips: Record<string, string> = {};
    try {
      ips = Object.fromEntries(Object.entries(await cloud.getIps(token, homeId)).map(([k, v]) => [normaliseLocalName(k), v]));
    } catch {
      log.debug('Superfan: could not fetch fan addresses from the cloud; will use local discovery');
    }
    for (const fan of found.fans) {
      if (byId.has(fan.deviceId)) continue;
      const cloudHost = ips[fan.localName];
      byId.set(fan.deviceId, cloudHost ? { ...fan, cloudHost } : fan);
    }
    for (const s of found.skipped) skipped.set(s.name, s);
  }

  log.info(`Superfan: found ${byId.size} fan(s) on your account`);
  return { fans: [...byId.values()], skipped: [...skipped.values()] };
}
