export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Normalised fan status. `relays[i]` is the state (0|1) of `switch_no = i + 1`. */
export interface FanStatus {
  relays: number[];
  dimmer?: number;
}

export interface FanRecord {
  deviceId: string;
  name: string;
  model: string;
  apikey: string;
  apiSecret: string;
  /** wifi_local_name, normalised (lowercase, no trailing "."). */
  localName: string;
  fanSwitchNo: number;
  steps: number;
  lightSwitchNo?: number;
  cloudHost?: string;
}

export interface FanState {
  online: boolean;
  fanOn: boolean;
  speed: number;
  lightOn: boolean;
}

export interface CacheData {
  version: 1;
  fans: FanRecord[];
  lastHosts: Record<string, string>;
}
