import { describe, expect, it } from 'vitest';
import { computeStats, formatMs } from '../src/core/latency-stats';

/**
 * The spec's own §1 measurement found a 2.7x spread across three identical
 * prompts on the same warm box — proof that one run proves nothing. The
 * harness must report median + spread, not a single number, per the task's
 * "Prove it against dev" method. These are the pure statistics that back that
 * report — no network, no clock, so they get a fast, deterministic test.
 */
describe('computeStats', () => {
  it('reports count, min, max, median, mean, p90, and spread for an odd sample', () => {
    const stats = computeStats([10, 30, 20]);
    expect(stats.count).toBe(3);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
    expect(stats.median).toBe(20);
    expect(stats.mean).toBeCloseTo(20, 5);
    expect(stats.spread).toBeCloseTo(3, 5); // max/min, matches the spec's "2.7x spread" framing
  });

  it('reports the average of the two middle values for an even sample', () => {
    const stats = computeStats([10, 20, 30, 40]);
    expect(stats.median).toBe(25);
  });

  it('reproduces the spec’s own three-run baseline spread', () => {
    // send -> model starts: 4.90s, 2.54s, 7.03s (the turn-latency spec (PR #7840) §1)
    const stats = computeStats([4900, 2540, 7030]);
    expect(stats.min).toBe(2540);
    expect(stats.max).toBe(7030);
    expect(stats.spread).toBeCloseTo(7030 / 2540, 5);
    expect(stats.spread).toBeGreaterThan(2.7);
    expect(stats.spread).toBeLessThan(2.8);
  });

  it('does not divide by zero when every sample is identical', () => {
    const stats = computeStats([100, 100, 100]);
    expect(stats.spread).toBe(1);
  });

  it('does not divide by zero when the minimum sample is exactly zero', () => {
    const stats = computeStats([0, 5, 10]);
    expect(stats.spread).toBe(Infinity);
  });

  it('throws on an empty sample instead of returning misleading zeros', () => {
    expect(() => computeStats([])).toThrow('at least one sample');
  });

  it('is order-independent', () => {
    const a = computeStats([3, 1, 2]);
    const b = computeStats([1, 2, 3]);
    expect(a).toEqual(b);
  });
});

describe('formatMs', () => {
  it('formats sub-second values in ms and second-plus values in s', () => {
    expect(formatMs(4)).toBe('4ms');
    expect(formatMs(150)).toBe('150ms');
    expect(formatMs(999)).toBe('999ms');
    expect(formatMs(1000)).toBe('1.00s');
    expect(formatMs(4900)).toBe('4.90s');
    expect(formatMs(10560)).toBe('10.56s');
  });
});
