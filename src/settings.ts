export const PLATFORM_NAME = 'Superfan';
export const PLUGIN_NAME = 'homebridge-superfan';

export const PARTNER_ID = '64183d9c85be48b30615fac4';
export const CLOUD_BASE_URL = 'https://api.kiot.io/api/v1/';

export const MANUFACTURER = 'Superfan';
export const MODEL_FALLBACK = 'Superfan Smart Fan';

export const DEFAULT_POLL_INTERVAL_S = 5;
export const DEFAULT_SPEED_STEPS = 5;
export const OFFLINE_AFTER_FAILURES = 3;
export const OFFLINE_BACKOFF_CAP_MS = 30_000;
export const REREAD_AFTER_COMMAND_MS = 1_000;

/** Login/sign-up endpoints live at the bare host, without the /api/v1 prefix. */
export const CLOUD_AUTH_BASE_URL = 'https://api.kiot.io/';
