import type { CharacteristicValue, HAP, PlatformAccessory } from 'homebridge';
import { OfflineError, type FanControllerLike } from './controller.js';
import { MANUFACTURER } from './settings.js';
import { rotationToSpeed, speedToRotation } from './speed.js';
import type { FanRecord, FanState, Logger } from './types.js';

export interface SuperfanAccessoryOptions {
  hap: HAP;
  accessory: Pick<PlatformAccessory, 'getService' | 'addService' | 'removeService'>;
  fan: FanRecord;
  controller: FanControllerLike;
  firmware?: string;
  log: Logger;
}

/** Maps one fan's controller state to HomeKit: a Fanv2 service plus an optional Lightbulb. */
export class SuperfanAccessory {
  private readonly hap: HAP;
  private readonly fan: FanRecord;
  private readonly controller: FanControllerLike;
  private readonly log: Logger;

  constructor(o: SuperfanAccessoryOptions) {
    this.hap = o.hap;
    this.fan = o.fan;
    this.controller = o.controller;
    this.log = o.log;
    const { Service, Characteristic } = this.hap;
    const { accessory, fan, controller } = o;

    const info = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, fan.model)
      .setCharacteristic(Characteristic.SerialNumber, fan.deviceId);
    if (o.firmware) {
      info.setCharacteristic(Characteristic.FirmwareRevision, o.firmware);
    }

    const fanService = accessory.getService(Service.Fanv2) ?? accessory.addService(Service.Fanv2, fan.name);
    const active = fanService
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.read((s) => (s.fanOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)))
      .onSet((v) => this.write(() => controller.setFanOn(v === Characteristic.Active.ACTIVE)));
    const speed = fanService
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 100 / fan.steps })
      .onGet(() => this.read((s) => speedToRotation(s.speed, fan.steps)))
      .onSet((v) => this.write(() => controller.setSpeed(rotationToSpeed(Number(v), fan.steps))));

    let lightOn: ReturnType<typeof fanService.getCharacteristic> | undefined;
    const existingLight = accessory.getService(Service.Lightbulb);
    if (fan.lightSwitchNo !== undefined) {
      const light = existingLight ?? accessory.addService(Service.Lightbulb, `${fan.name} Light`);
      lightOn = light
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.read((s) => s.lightOn))
        .onSet((v) => this.write(() => controller.setLight(v === true)));
    } else if (existingLight) {
      accessory.removeService(existingLight);
    }

    controller.on('change', (s: FanState) => {
      active.updateValue(s.fanOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      speed.updateValue(speedToRotation(s.speed, fan.steps));
      lightOn?.updateValue(s.lightOn);
    });
  }

  /** Read handler: current state, or "No Response" while the fan is unreachable. */
  private read(pick: (s: FanState) => CharacteristicValue): CharacteristicValue {
    const state = this.controller.state;
    if (!state.online) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return pick(state);
  }

  /** Write handler: run the command; any failure shows as "No Response" in Home. */
  private async write(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof OfflineError)) {
        this.log.warn(`${this.fan.name}: command failed (${(error as Error).message})`);
      }
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
