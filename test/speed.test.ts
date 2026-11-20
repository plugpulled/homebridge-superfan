import { describe, expect, test } from 'vitest';
import { fromDimm, rotationToSpeed, speedToRotation, toDimm } from '../src/speed.js';

describe('toDimm (speed step -> fan dimmer value)', () => {
  test('5-step fan uses 20/40/60/80 and 99 for the top step', () => {
    expect([1, 2, 3, 4, 5].map((s) => toDimm(s, 5))).toEqual([20, 40, 60, 80, 99]);
  });

  test('other step counts scale the same way', () => {
    expect(toDimm(2, 4)).toBe(50);
    expect(toDimm(4, 4)).toBe(99);
    expect(toDimm(1, 3)).toBe(33);
  });
});

describe('fromDimm (fan dimmer value -> speed step)', () => {
  test('round-trips the 5-step values', () => {
    expect([20, 40, 60, 80, 99].map((v) => fromDimm(v, 5))).toEqual([1, 2, 3, 4, 5]);
  });

  test('low values map to the lowest step', () => {
    expect(fromDimm(0, 5)).toBe(1);
    expect(fromDimm(10, 5)).toBe(1);
  });

  test('in-between and out-of-range values stay within 1..steps', () => {
    expect(fromDimm(50, 5)).toBe(2);
    expect(fromDimm(100, 5)).toBe(5);
    expect(fromDimm(100, 3)).toBe(3);
  });
});

describe('speedToRotation (speed step -> HomeKit RotationSpeed %)', () => {
  test('maps steps to evenly spaced percentages', () => {
    expect(speedToRotation(3, 5)).toBe(60);
    expect(speedToRotation(5, 5)).toBe(100);
    expect(speedToRotation(0, 5)).toBe(0);
  });
});

describe('rotationToSpeed (HomeKit RotationSpeed % -> speed step)', () => {
  test('0% means off', () => {
    expect(rotationToSpeed(0, 5)).toBe(0);
  });

  test('any non-zero value is at least step 1', () => {
    expect(rotationToSpeed(1, 5)).toBe(1);
  });

  test('rounds to the nearest step', () => {
    expect(rotationToSpeed(60, 5)).toBe(3);
    expect(rotationToSpeed(70, 5)).toBe(4);
    expect(rotationToSpeed(100, 5)).toBe(5);
    expect(rotationToSpeed(33, 3)).toBe(1);
    expect(rotationToSpeed(100, 3)).toBe(3);
  });
});
