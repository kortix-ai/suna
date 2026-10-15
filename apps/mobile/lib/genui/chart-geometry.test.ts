import { describe, expect, test } from 'bun:test';

import { axisMax, barPath, barRects, linePath, pieArcs, pieVariant, pickIndex } from './chart-geometry';

describe('chart geometry', () => {
  test('axis max is the largest value and never 0', () => {
    expect(axisMax([[1, 5], [3]])).toBe(5);
    expect(axisMax([[0, 0]])).toBe(1);
    expect(axisMax([[Number.NaN, -2]])).toBe(1);
  });

  test('bars are bottom-aligned, scaled to the max, grouped per category', () => {
    const rects = barRects([[10, 5]], 2, 200, 100, 4);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ y: 0, height: 100, index: 0, series: 0 });
    expect(rects[1]).toMatchObject({ y: 50, height: 50, index: 1 });
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
  });

  test('negative and missing values draw as 0', () => {
    const rects = barRects([[-3]], 2, 100, 100);
    expect(rects.map((r) => r.height)).toEqual([0, 0]);
  });

  test('bars stay inside their category, even 24 categories of 4 series on a phone', () => {
    const groupWidth = 320 / 24;
    const rects = barRects([[1], [2], [3], [4]].map((v) => Array(24).fill(v[0])), 24, 320, 100);
    expect(rects).toHaveLength(96);
    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(r.index * groupWidth);
      expect(r.x + r.width).toBeLessThanOrEqual((r.index + 1) * groupWidth);
    }
  });

  test('a bar is at most 48 wide and centered in its category', () => {
    const [bar] = barRects([[1]], 1, 300, 100);
    expect(bar).toMatchObject({ x: 126, width: 48 });
  });

  test('a bar path rounds its top corners and stays square on the baseline', () => {
    const bar = { x: 0, y: 0, width: 10, height: 20, series: 0, index: 0 };
    expect(barPath(bar, 4)).toBe('M0.00,20.00 V4.00 A4.00,4.00 0 0 1 4.00,0.00 H6.00 A4.00,4.00 0 0 1 10.00,4.00 V20.00 Z');
    // A bar shorter or narrower than the radius shrinks the radius instead of overshooting.
    expect(barPath({ ...bar, y: 18, height: 2 }, 4)).toBe('M0.00,20.00 V20.00 A2.00,2.00 0 0 1 2.00,18.00 H8.00 A2.00,2.00 0 0 1 10.00,20.00 V20.00 Z');
    expect(barPath({ ...bar, y: 20, height: 0 }, 4)).toBe('');
  });

  test('a series shorter than the x labels keeps its points on their x slots', () => {
    expect(linePath([0, 10], 100, 50, 10, 3)).toBe('M0.00,50.00 L50.00,0.00');
  });

  test('line path spans the width', () => {
    expect(linePath([0, 10], 100, 50, 10)).toBe('M0.00,50.00 L100.00,0.00');
    expect(linePath([], 100, 50, 10)).toBe('');
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
