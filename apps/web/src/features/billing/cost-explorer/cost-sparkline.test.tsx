import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CostSparkline, seriesTrend, sparklinePath } from './cost-sparkline';

describe('seriesTrend', () => {
  test('rising spend is up', () => {
    expect(seriesTrend([1, 1, 5, 6])).toBe('up');
  });

  test('falling spend is down', () => {
    expect(seriesTrend([6, 5, 1, 1])).toBe('down');
  });

  test('an unchanged line is flat, not a direction', () => {
    expect(seriesTrend([3, 3, 3, 3])).toBe('flat');
  });

  test('an all-zero window is flat rather than dividing by zero', () => {
    expect(seriesTrend([0, 0, 0, 0])).toBe('flat');
  });

  test('a single point has no direction to report', () => {
    expect(seriesTrend([4])).toBe('flat');
    expect(seriesTrend([])).toBe('flat');
  });

  // The reason halves are compared rather than first-against-last: daily spend
  // is spiky, and one quiet day at an end should not set the window's trend.
  test('one quiet final day does not flip an otherwise rising window', () => {
    expect(seriesTrend([1, 1, 1, 9, 9, 0])).toBe('up');
  });

  test('a movement too small to be real reads flat', () => {
    expect(seriesTrend([100, 100, 100.4, 100.4])).toBe('flat');
  });
});

describe('sparklinePath', () => {
  test('starts at the first point and passes through the last', () => {
    const path = sparklinePath([0, 10], 100, 20);
    // y grows downward in SVG, so the maximum lands at y=0.
    expect(path.startsWith('M 0,20')).toBe(true);
    expect(path.endsWith('100,0')).toBe(true);
  });

  test('curves rather than joining points with straight segments', () => {
    // `C` is the cubic Bezier command — a polyline would have none.
    expect(sparklinePath([1, 8, 2, 9], 100, 20)).toContain('C ');
  });

  test('passes exactly through every data point, never near them', () => {
    // Catmull-Rom is interpolating, not approximating. Each segment must end
    // on a real point, or the curve draws spend that was not billed.
    const path = sparklinePath([0, 10, 0], 100, 20);
    expect(path).toContain('50,0');
    expect(path.endsWith('100,20')).toBe(true);
  });

  test('never bows outside the box around a spike', () => {
    // Unclamped Catmull-Rom overshoots at a sharp peak, drawing the line above
    // the window's real maximum. Every coordinate must stay within [0, height].
    const height = 20;
    const path = sparklinePath([0, 0, 20, 0, 0], 100, height);
    const ys = [...path.matchAll(/[ ,](-?\d+(?:\.\d+)?)(?=[ ]|$)/g)].map((m) => Number(m[1]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }
  });

  test('a flat series draws down the middle, not pinned to an edge', () => {
    // At y=0 a flat line would read as "at maximum" when it means "never moved".
    const path = sparklinePath([5, 5, 5], 100, 20);
    expect(path.startsWith('M 0,10')).toBe(true);
    expect(path.endsWith('100,10')).toBe(true);
  });

  test('too few points produce no line at all', () => {
    expect(sparklinePath([7])).toBe('');
    expect(sparklinePath([])).toBe('');
  });
});

describe('CostSparkline', () => {
  test('renders nothing when there is no trend to draw', () => {
    expect(renderToStaticMarkup(<CostSparkline values={[7]} label="Total" />)).toBe('');
  });

  test('rising spend is red, because on a cost surface up is the alarming way', () => {
    const html = renderToStaticMarkup(<CostSparkline values={[1, 1, 8, 9]} label="Total" />);
    expect(html).toContain('text-kortix-red');
    expect(html).not.toContain('text-kortix-green');
  });

  test('falling spend is green', () => {
    const html = renderToStaticMarkup(<CostSparkline values={[9, 8, 1, 1]} label="Total" />);
    expect(html).toContain('text-kortix-green');
    expect(html).not.toContain('text-kortix-red');
  });

  test('a flat line stays neutral rather than reassuring or alarming', () => {
    const html = renderToStaticMarkup(<CostSparkline values={[4, 4, 4, 4]} label="LLM" />);
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toContain('text-kortix-green');
    expect(html).not.toContain('text-kortix-red');
  });

  test('carries an accessible name naming the metric and the direction', () => {
    // It is the only trend signal on the LLM and Compute tiles, so it must not
    // be aria-hidden. `role="img"` is what makes the label reliably exposed.
    const html = renderToStaticMarkup(<CostSparkline values={[9, 8, 1, 1]} label="Compute" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Compute spend trending down over the selected range"');
  });

  test('keeps the stroke an even weight when the box is stretched', () => {
    const html = renderToStaticMarkup(<CostSparkline values={[1, 5]} label="Total" />);
    expect(html).toContain('non-scaling-stroke');
  });

  test('draws a curved path, not a polyline', () => {
    const html = renderToStaticMarkup(<CostSparkline values={[1, 8, 2, 9]} label="Total" />);
    expect(html).toContain('<path');
    expect(html).not.toContain('<polyline');
  });
});
