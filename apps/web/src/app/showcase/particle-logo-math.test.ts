import { describe, expect, test } from 'bun:test';
import {
  breathePulse,
  clamp01,
  easeInOutCubic,
  lerp,
  mulberry32,
  samplePixelHomes,
} from './particle-logo-math';

describe('mulberry32', () => {
  test('is deterministic for a given seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()]);
  });

  test('stays within [0, 1)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('easeInOutCubic', () => {
  test('pins endpoints and midpoint, clamps out of range', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

describe('clamp01 / lerp', () => {
  test('clamp01 clamps to the unit interval', () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(5)).toBe(1);
  });

  test('lerp interpolates between endpoints', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(-4, 4, 0.25)).toBe(-2);
  });
});

describe('samplePixelHomes', () => {
  const rect = (w: number, h: number, filled: (x: number, y: number) => boolean) => {
    return (x: number, y: number) => (x < w && y < h && filled(x, y) ? 255 : 0);
  };

  test('collects one home per opaque grid cell on a full 10x10 field at stride 5', () => {
    const homes = samplePixelHomes(
      10,
      10,
      5,
      rect(10, 10, () => true),
    );
    expect(homes).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 0, y: 5 },
      { x: 5, y: 5 },
    ]);
  });

  test('skips cells under the alpha threshold when only the left half is opaque', () => {
    const homes = samplePixelHomes(
      10,
      10,
      5,
      rect(10, 10, (x) => x < 5),
    );
    expect(homes).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
    ]);
  });

  test('guards a non-positive stride', () => {
    expect(samplePixelHomes(10, 10, 0, () => 255)).toEqual([]);
  });
});

describe('breathePulse', () => {
  test('is zero at the start of a cycle', () => {
    expect(breathePulse(0, 1500)).toBeCloseTo(0, 10);
  });

  test('stays within [-1, 1]', () => {
    for (let now = 0; now < 3000; now += 50) {
      expect(Math.abs(breathePulse(now, 1500))).toBeLessThanOrEqual(1);
    }
  });

  test('guards a non-positive period and is deterministic', () => {
    expect(breathePulse(123, 0)).toBe(0);
    expect(breathePulse(700, 1500)).toBe(breathePulse(700, 1500));
  });
});
