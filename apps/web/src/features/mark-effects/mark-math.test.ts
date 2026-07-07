import { describe, expect, test } from 'bun:test';
import { clamp, clamp01, flowAngle, proximityFalloff, smoothstep } from './mark-math';

describe('clamp / clamp01', () => {
  test('clamps to bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-2)).toBe(0);
  });
});

describe('smoothstep', () => {
  test('pins ends, eases middle, clamps out of range', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 10);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });
});

describe('proximityFalloff', () => {
  test('is 1 at the origin and 0 at/after the radius', () => {
    expect(proximityFalloff(0, 100)).toBe(1);
    expect(proximityFalloff(100, 100)).toBe(0);
    expect(proximityFalloff(200, 100)).toBe(0);
  });

  test('decreases monotonically across the radius', () => {
    let prev = Infinity;
    for (let d = 0; d <= 100; d += 10) {
      const v = proximityFalloff(d, 100);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  test('guards a zero radius', () => {
    expect(proximityFalloff(0, 0)).toBe(0);
  });
});

describe('flowAngle', () => {
  test('is deterministic and finite', () => {
    expect(flowAngle(120, 80, 1.5)).toBe(flowAngle(120, 80, 1.5));
    expect(Number.isFinite(flowAngle(4000, 3000, 42))).toBe(true);
  });

  test('evaluates the closed form at the origin', () => {
    expect(flowAngle(0, 0, 0)).toBeCloseTo(Math.PI / 1.5, 10);
  });

  test('varies across space at a fixed time', () => {
    expect(flowAngle(0, 0, 2)).not.toBe(flowAngle(300, 200, 2));
  });
});
