import { describe, expect, test } from 'bun:test';

import { barPath, barRects, compactNumber, zeroY, linePath, pieArcs, pieVariant, pickIndex, valueScale } from './chart-geometry';

describe('chart geometry', () => {
  test('the value scale spans 0 and every value on 4-5 nice ticks', () => {
    expect(valueScale([[1200, 900], [400, 500]])).toEqual({ min: 0, max: 1500, ticks: [0, 500, 1000, 1500] });
    expect(valueScale([[1, 5], [3]])).toEqual({ min: 0, max: 6, ticks: [0, 2, 4, 6] });
    // Negative values pull the domain below 0; 0 stays a tick, so the zero line is a grid line.
    expect(valueScale([[-30, 50]])).toEqual({ min: -40, max: 60, ticks: [-40, -20, 0, 20, 40, 60] });
    expect(valueScale([[-5, -2]])).toEqual({ min: -6, max: 0, ticks: [-6, -4, -2, 0] });
    expect(valueScale([[0.1, 0.3]])).toEqual({ min: 0, max: 0.3, ticks: [0, 0.1, 0.2, 0.3] });
    // No data: a plot that can still scale, and one 0 tick, never a made-up max.
    expect(valueScale([[0, 0]])).toEqual({ min: 0, max: 1, ticks: [0] });
    expect(valueScale([[Number.NaN]])).toEqual({ min: 0, max: 1, ticks: [0] });
  });

  test('compact numbers match web (Intl compact notation)', () => {
    expect(compactNumber(1500, 'en')).toBe('1.5K');
    expect(compactNumber(-40, 'en')).toBe('-40');
    expect(compactNumber(2_000_000, 'en')).toBe('2M');
    expect(compactNumber(0.25, 'en')).toBe('0.25');
  });

  test('bars are bottom-aligned, scaled to the max, grouped per category', () => {
    const rects = barRects([[10, 5]], 2, 200, 100, { min: 0, max: 10 }, 4);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ y: 0, height: 100, index: 0, series: 0 });
    expect(rects[1]).toMatchObject({ y: 50, height: 50, index: 1 });
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
  });

  test('a missing value draws no bar', () => {
    const rects = barRects([[3]], 2, 100, 100, { min: 0, max: 3 });
    expect(rects.map((r) => r.height)).toEqual([100, 0]);
  });

  test('a negative bar grows down from the zero line, a positive one up', () => {
    // Domain -40..60 on a 100pt plot: zero sits at y 60.
    const [down, up] = barRects([[-30, 50]], 2, 200, 100, { min: -40, max: 60 });
    expect(down).toMatchObject({ y: 60, height: 30, negative: true });
    expect(up).toMatchObject({ y: 10, height: 50, negative: false });
    expect(zeroY({ min: -40, max: 60 }, 100)).toBe(60);
    expect(zeroY({ min: 0, max: 10 }, 100)).toBe(100);
  });

  test('a negative bar path rounds its bottom corners and stays square on the zero line', () => {
    const bar = { x: 0, y: 0, width: 10, height: 20, series: 0, index: 0, negative: true };
    expect(barPath(bar, 4)).toBe('M0.00,0.00 V16.00 A4.00,4.00 0 0 0 4.00,20.00 H6.00 A4.00,4.00 0 0 0 10.00,16.00 V0.00 Z');
  });

  test('bars stay inside their category, even 24 categories of 4 series on a phone', () => {
    const groupWidth = 320 / 24;
    const rects = barRects([[1], [2], [3], [4]].map((v) => Array(24).fill(v[0])), 24, 320, 100, { min: 0, max: 4 });
    expect(rects).toHaveLength(96);
    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(r.index * groupWidth);
      expect(r.x + r.width).toBeLessThanOrEqual((r.index + 1) * groupWidth);
    }
  });

  test('a bar is at most 48 wide and centered in its category', () => {
    const [bar] = barRects([[1]], 1, 300, 100, { min: 0, max: 1 });
    expect(bar).toMatchObject({ x: 126, width: 48 });
  });

  test('a bar path rounds its top corners and stays square on the baseline', () => {
    const bar = { x: 0, y: 0, width: 10, height: 20, series: 0, index: 0, negative: false };
    expect(barPath(bar, 4)).toBe('M0.00,20.00 V4.00 A4.00,4.00 0 0 1 4.00,0.00 H6.00 A4.00,4.00 0 0 1 10.00,4.00 V20.00 Z');
    // A bar shorter or narrower than the radius shrinks the radius instead of overshooting.
    expect(barPath({ ...bar, y: 18, height: 2 }, 4)).toBe('M0.00,20.00 V20.00 A2.00,2.00 0 0 1 2.00,18.00 H8.00 A2.00,2.00 0 0 1 10.00,20.00 V20.00 Z');
    expect(barPath({ ...bar, y: 20, height: 0 }, 4)).toBe('');
  });

  test('a series shorter than the x labels keeps its points on their x slots', () => {
    expect(linePath([0, 10], 100, 50, { min: 0, max: 10 }, 3)).toBe('M0.00,50.00 L50.00,0.00');
  });

  test('line path spans the width', () => {
    expect(linePath([0, 10], 100, 50, { min: 0, max: 10 })).toBe('M0.00,50.00 L100.00,0.00');
    expect(linePath([], 100, 50, { min: 0, max: 10 })).toBe('');
  });

  test('a line plots a negative value below the zero line', () => {
    expect(linePath([-10, 10], 100, 40, { min: -10, max: 10 })).toBe('M0.00,40.00 L100.00,0.00');
  });

  test('pie arcs: one path per non-zero slice; all-zero draws nothing', () => {
    expect(pieArcs([1, 0, 1], 50, 30).map((a) => a.index)).toEqual([0, 2]);
    expect(pieArcs([0, 0], 50, 30)).toEqual([]);
    expect(pieArcs([5], 50, 30)[0]!.path.startsWith('M50.00,0.00')).toBe(true);
  });

  test('a half-ring gauge starts at 9 o\'clock and ends at 3 o\'clock', () => {
    const arcs = pieArcs([1, 1], 50, 30, -Math.PI / 2, Math.PI);
    expect(arcs[0]!.path.startsWith('M0.00,50.00')).toBe(true);
    // The second slice ends at the right edge, on the center line.
    expect(arcs[1]!.path).toContain('100.00,50.00');
  });

  test('the pie variant is the model\'s when known; otherwise two slices are a gauge and more a donut', () => {
    expect(pieVariant('treemap', 4)).toBe('treemap');
    expect(pieVariant(undefined, 2)).toBe('gauge');
    expect(pieVariant(undefined, 4)).toBe('donut');
    expect(pieVariant('spiral', 3)).toBe('donut');
  });
});

describe('pickIndex', () => {
  test('a tap picks the bar group under the finger, or the nearest line point; outside the plot clamps', () => {
    expect(pickIndex(10, 300, 3, false)).toBe(0);
    expect(pickIndex(150, 300, 3, false)).toBe(1);
    expect(pickIndex(299, 300, 3, false)).toBe(2);
    expect(pickIndex(70, 300, 3, true)).toBe(0);
    expect(pickIndex(80, 300, 3, true)).toBe(1);
    expect(pickIndex(-20, 300, 3, true)).toBe(0);
    expect(pickIndex(400, 300, 3, false)).toBe(2);
    expect(pickIndex(100, 300, 1, false)).toBe(0);
  });
});
