import { describe, expect, test } from 'bun:test';
import { shortestAngleDelta, smooth, tiltToHeat, TILT_DEAD_ZONE_RAD, TILT_FULL_RAD } from './heat-tilt';

describe('tiltToHeat', () => {
  test('flat phone: sweep 0', () => {
    expect(tiltToHeat(0, 0).sweep).toBe(0);
  });
  test('inside the dead zone: sweep 0', () => {
    expect(tiltToHeat(TILT_DEAD_ZONE_RAD / 2, 0).sweep).toBe(0);
  });
  test('full tilt: sweep 1, clamped beyond', () => {
    expect(tiltToHeat(TILT_FULL_RAD, 0).sweep).toBeCloseTo(1, 5);
    expect(tiltToHeat(3, 3).sweep).toBe(1);
  });
  test('direction: roll right = 0 deg, pitch forward = 90 deg', () => {
    expect(tiltToHeat(0, 0.3).angleDeg).toBeCloseTo(0, 5);
    expect(tiltToHeat(0.3, 0).angleDeg).toBeCloseTo(90, 5);
  });
});

describe('shortestAngleDelta', () => {
  test('wraps across 180', () => {
    expect(shortestAngleDelta(170, -170)).toBeCloseTo(20, 5);
    expect(shortestAngleDelta(-170, 170)).toBeCloseTo(-20, 5);
  });
});

describe('smooth', () => {
  test('dt 0 keeps prev', () => expect(smooth(1, 5, 0, 0.1)).toBe(1));
  test('large dt reaches next', () => expect(smooth(1, 5, 10, 0.1)).toBeCloseTo(5, 3));
});
