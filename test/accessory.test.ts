import { EventEmitter } from 'node:events';
import * as hap from '@homebridge/hap-nodejs';
import type { HAP } from 'homebridge';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SuperfanAccessory } from '../src/accessory.js';
import { OfflineError, type FanControllerLike } from '../src/controller.js';
import type { FanRecord, FanState, Logger } from '../src/types.js';

const { Characteristic, Service } = hap;
const COMM_FAILURE = -70402;

const fan: FanRecord = {
  deviceId: 'aabbccddeeff', name: 'Bedroom Fan', model: 'Superfan Super Q', apikey: 'ak_fake', apiSecret: 'sk_fake',
  localName: 'fan_aabbccddeeff.local', fanSwitchNo: 1, steps: 5, lightSwitchNo: 2,
};

class FakeController extends EventEmitter implements FanControllerLike {
  state: FanState = { online: true, fanOn: false, speed: 1, lightOn: false };
  setFanOn = vi.fn(async (_on: boolean) => {});
  setSpeed = vi.fn(async (_speed: number) => {});
  setLight = vi.fn(async (_on: boolean) => {});
}

const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let accessory: hap.Accessory;
let controller: FakeController;

function build(f: FanRecord = fan, firmware = '4.2.0'): void {
  new SuperfanAccessory({ hap: hap as unknown as HAP, accessory, fan: f, controller, firmware, log });
}
const fanService = () => accessory.getService(Service.Fanv2)!;
const lightService = () => accessory.getService(Service.Lightbulb);

beforeEach(() => {
  accessory = new hap.Accessory('Bedroom Fan', hap.uuid.generate('test-aabbccddeeff'));
  controller = new FakeController();
});

describe('services', () => {
  test('accessory information describes the fan', () => {
    build();
    const info = accessory.getService(Service.AccessoryInformation)!;
    expect(info.getCharacteristic(Characteristic.Manufacturer).value).toBe('Superfan');
    expect(info.getCharacteristic(Characteristic.Model).value).toBe('Superfan Super Q');
    expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('aabbccddeeff');
    expect(info.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('4.2.0');
  });

  test('fan speed slider moves in one step per fan speed', () => {
    build();
    const props = fanService().getCharacteristic(Characteristic.RotationSpeed).props;
    expect(props).toMatchObject({ minValue: 0, maxValue: 100, minStep: 20 });
  });

  test('light service exists only when the fan has a light', () => {
    build();
    expect(lightService()).toBeDefined();
  });

  test('a previously cached light service is removed when the fan has no light', () => {
    accessory.addService(Service.Lightbulb, 'Old light');
    build({ ...fan, lightSwitchNo: undefined });
    expect(lightService()).toBeUndefined();
    expect(fanService()).toBeDefined();
  });

  test('restoring an accessory reuses its services instead of duplicating them', () => {
    build();
    build();
    expect(accessory.services.filter((s) => s.UUID === Service.Fanv2.UUID)).toHaveLength(1);
    expect(accessory.services.filter((s) => s.UUID === Service.Lightbulb.UUID)).toHaveLength(1);
  });
});

describe('reads', () => {
  test('report the controller state', async () => {
    build();
    controller.state = { online: true, fanOn: true, speed: 3, lightOn: true };
    expect(await fanService().getCharacteristic(Characteristic.Active).handleGetRequest()).toBe(1);
    expect(await fanService().getCharacteristic(Characteristic.RotationSpeed).handleGetRequest()).toBe(60);
    expect(await lightService()!.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(true);
    controller.state = { online: true, fanOn: false, speed: 3, lightOn: false };
    expect(await fanService().getCharacteristic(Characteristic.Active).handleGetRequest()).toBe(0);
    expect(await lightService()!.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false);
  });

  test('offline fan reads as "No Response" (HapStatusError, not a crash)', async () => {
    build();
    controller.state = { online: false, fanOn: true, speed: 3, lightOn: false };
    for (const c of [
      fanService().getCharacteristic(Characteristic.Active),
      fanService().getCharacteristic(Characteristic.RotationSpeed),
      lightService()!.getCharacteristic(Characteristic.On),
    ]) {
      const warnings = vi.fn();
      c.on('characteristic-warning', warnings);
      await expect(c.handleGetRequest()).rejects.toBe(COMM_FAILURE);
      expect(warnings).not.toHaveBeenCalled();
    }
  });
});

describe('writes', () => {
  test('route to the controller', async () => {
    build();
    await fanService().getCharacteristic(Characteristic.Active).handleSetRequest(1);
    expect(controller.setFanOn).toHaveBeenCalledWith(true);
    await fanService().getCharacteristic(Characteristic.Active).handleSetRequest(0);
    expect(controller.setFanOn).toHaveBeenCalledWith(false);
    await fanService().getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(60);
    expect(controller.setSpeed).toHaveBeenLastCalledWith(3);
    await fanService().getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(0);
    expect(controller.setSpeed).toHaveBeenLastCalledWith(0);
    await lightService()!.getCharacteristic(Characteristic.On).handleSetRequest(true);
    expect(controller.setLight).toHaveBeenCalledWith(true);
  });

  test('failed commands surface as "No Response"', async () => {
    build();
    controller.setFanOn.mockRejectedValueOnce(new OfflineError('Bedroom Fan'));
    controller.setLight.mockRejectedValueOnce(new Error('HTTP 500'));
    const active = fanService().getCharacteristic(Characteristic.Active);
    const on = lightService()!.getCharacteristic(Characteristic.On);
    const warnings = vi.fn();
    active.on('characteristic-warning', warnings);
    on.on('characteristic-warning', warnings);
    await expect(active.handleSetRequest(1)).rejects.toBe(COMM_FAILURE);
    await expect(on.handleSetRequest(true)).rejects.toBe(COMM_FAILURE);
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe('state updates', () => {
  test("controller 'change' pushes new values to HomeKit", () => {
    build();
    controller.emit('change', { online: true, fanOn: true, speed: 4, lightOn: false });
    expect(fanService().getCharacteristic(Characteristic.Active).value).toBe(1);
    expect(fanService().getCharacteristic(Characteristic.RotationSpeed).value).toBe(80);
    expect(lightService()!.getCharacteristic(Characteristic.On).value).toBe(false);
    controller.emit('change', { online: true, fanOn: false, speed: 4, lightOn: true });
    expect(fanService().getCharacteristic(Characteristic.Active).value).toBe(0);
    expect(lightService()!.getCharacteristic(Characteristic.On).value).toBe(true);
  });
});
