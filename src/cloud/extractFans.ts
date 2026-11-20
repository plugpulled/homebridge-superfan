import { DEFAULT_SPEED_STEPS, MODEL_FALLBACK } from '../settings.js';
import type { FanRecord } from '../types.js';

export interface SkippedFan {
  name: string;
  reason: string;
  deviceId?: string;
}

interface RawSwitch {
  switch_no?: unknown;
  switch_type?: unknown;
  dimming_steps?: unknown;
  feature?: { name?: unknown }[];
}

interface RawDevice {
  kd_id?: unknown;
  device_name?: unknown;
  switch_appliances?: RawSwitch[];
  device_info?: {
    device_id?: unknown;
    dev_type?: unknown;
    apikey?: unknown;
    apiSecret?: unknown;
    wifi_local_name?: unknown;
  };
}

/** `wifi_local_name` / mDNS names: lowercase, no trailing dot. */
export function normaliseLocalName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

const featureOf = (s: RawSwitch): unknown => (Array.isArray(s.feature) ? s.feature[0]?.name : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Pull the supported fans (and their local keys) out of a `userdevices/mydevices` response. */
export function extractFans(raw: unknown): { fans: FanRecord[]; skipped: SkippedFan[] } {
  const fans: FanRecord[] = [];
  const skipped: SkippedFan[] = [];
  const body = (raw && typeof raw === 'object' ? raw : {}) as { rooms?: unknown; other_devices?: unknown };
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  const devices: RawDevice[] = [
    ...rooms.flatMap((r: { devices?: unknown }) => (Array.isArray(r?.devices) ? r.devices : [])),
    ...(Array.isArray(body.other_devices) ? body.other_devices : []),
  ];

  for (const device of devices) {
    const switches = Array.isArray(device?.switch_appliances) ? device.switch_appliances : [];
    const isFan = device?.device_info?.dev_type === 'FAN' || switches.some((s) => featureOf(s) === 'fan_fan');
    if (!isFan) continue;

    const name = str(device.device_name) ?? 'Superfan Fan';
    const info = device.device_info ?? {};
    const id = (str(info.device_id) ?? str(device.kd_id))?.toLowerCase();
    const regulators = switches.filter((s) => featureOf(s) === 'fan_fan' && s.switch_type === 'regulator');
    const lights = switches.filter((s) => featureOf(s) === 'fan_light' && s.switch_type === 'toggle');
    const others = switches.length - regulators.length - lights.length;
    if (regulators.length !== 1 || lights.length > 1 || others > 0) {
      skipped.push({ name, reason: 'unsupported switch layout', ...(id ? { deviceId: id } : {}) });
      continue;
    }

    const apikey = str(info.apikey);
    const apiSecret = str(info.apiSecret);
    if (!apikey || !apiSecret || !id) {
      skipped.push({ name, reason: 'missing local access keys', ...(id ? { deviceId: id } : {}) });
      continue;
    }

    const deviceId = id;
    const steps = Number(regulators[0].dimming_steps);
    const fan: FanRecord = {
      deviceId,
      name,
      model: MODEL_FALLBACK,
      apikey,
      apiSecret,
      localName: normaliseLocalName(str(info.wifi_local_name) ?? `fan_${deviceId}.local`),
      fanSwitchNo: Number(regulators[0].switch_no) || 1,
      steps: Number.isInteger(steps) && steps > 0 ? steps : DEFAULT_SPEED_STEPS,
    };
    if (lights.length === 1) {
      fan.lightSwitchNo = Number(lights[0].switch_no);
    }
    fans.push(fan);
  }
  return { fans, skipped };
}
