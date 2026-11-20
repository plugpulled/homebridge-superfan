import { describe, expect, test } from 'vitest';
import { extractFans, normaliseLocalName } from '../src/cloud/extractFans.js';
import mydevices from './fixtures/mydevices.json' with { type: 'json' };

describe('extractFans', () => {
  const { fans, skipped } = extractFans(mydevices);

  test('fan with a light', () => {
    expect(fans).toContainEqual({
      deviceId: 'aabbccddeeff', name: 'Bedroom Fan', model: 'Superfan Smart Fan',
      apikey: 'ak_fake_aabbccddeeff', apiSecret: 'sk_fake_aabbccddeeff', localName: 'fan_aabbccddeeff.local',
      fanSwitchNo: 1, steps: 5, lightSwitchNo: 2,
    });
  });

  test('fan without a light (like the owner\'s 3-step fan)', () => {
    const study = fans.find((f) => f.deviceId === '112233445566');
    expect(study).toEqual({
      deviceId: '112233445566', name: 'Study Fan', model: 'Superfan Smart Fan',
      apikey: 'ak_fake_112233445566', apiSecret: 'sk_fake_112233445566', localName: 'fan_112233445566.local',
      fanSwitchNo: 1, steps: 3,
    });
    expect(study).not.toHaveProperty('lightSwitchNo');
  });

  test('a fan with two regulators is skipped as unsupported', () => {
    expect(fans.map((f) => f.deviceId)).not.toContain('665544332211');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].name).toBe('Twin Fan');
    expect(skipped[0].reason).toMatch(/unsupported/i);
    expect(skipped[0].deviceId).toBe('665544332211');
  });

  test('non-fan devices are ignored silently', () => {
    expect(fans.map((f) => f.deviceId)).not.toContain('998877665544');
    expect(skipped.map((s) => s.name)).not.toContain('Hall Switch');
  });

  test('missing dimming_steps defaults to 5', () => {
    const raw = structuredClone(mydevices) as typeof mydevices;
    delete (raw.rooms[0].devices[1].switch_appliances[0] as { dimming_steps?: number }).dimming_steps;
    expect(extractFans(raw).fans.find((f) => f.deviceId === '112233445566')?.steps).toBe(5);
  });

  test('a fan without local keys is skipped', () => {
    const raw = structuredClone(mydevices) as typeof mydevices;
    delete (raw.rooms[0].devices[1].device_info as { apiSecret?: string }).apiSecret;
    const result = extractFans(raw);
    expect(result.fans.map((f) => f.deviceId)).not.toContain('112233445566');
    expect(result.skipped.map((s) => s.name)).toContain('Study Fan');
  });

  test('devices listed under other_devices are included too', () => {
    const raw = structuredClone(mydevices) as unknown as { rooms: typeof mydevices.rooms; other_devices: unknown[] };
    raw.other_devices = [raw.rooms[0].devices[1]];
    raw.rooms[0].devices.splice(1, 1);
    expect(extractFans(raw).fans.map((f) => f.deviceId)).toContain('112233445566');
  });

  test('garbage input yields nothing', () => {
    expect(extractFans(null)).toEqual({ fans: [], skipped: [] });
    expect(extractFans({ rooms: 'x' })).toEqual({ fans: [], skipped: [] });
  });
});

describe('normaliseLocalName', () => {
  test('lowercases and drops the trailing dot', () => {
    expect(normaliseLocalName('FAN_AABB.local.')).toBe('fan_aabb.local');
    expect(normaliseLocalName('fan_aabb.local')).toBe('fan_aabb.local');
  });
});
