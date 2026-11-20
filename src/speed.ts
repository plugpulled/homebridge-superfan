const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Speed step (1..steps) -> dimmer value the fan firmware expects. Top step is 99, not 100. */
export function toDimm(speed: number, steps: number): number {
  return speed === steps ? 99 : Math.floor(speed * (100 / steps));
}

/** Dimmer value reported by the fan -> speed step (1..steps). */
export function fromDimm(value: number, steps: number): number {
  let speed: number;
  if (value === 99) {
    speed = steps;
  } else if (value < 100 / steps) {
    speed = 1;
  } else {
    speed = Math.floor(value / Math.floor(100 / steps));
  }
  return clamp(speed, 1, steps);
}

/** Speed step -> HomeKit RotationSpeed percentage. */
export function speedToRotation(speed: number, steps: number): number {
  return (speed * 100) / steps;
}

/** HomeKit RotationSpeed percentage -> speed step; 0 means off. */
export function rotationToSpeed(pct: number, steps: number): number {
  if (pct <= 0) {
    return 0;
  }
  return clamp(Math.round(pct / (100 / steps)), 1, steps);
}
