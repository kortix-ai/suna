import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CostSeriesPoint } from '@kortix/sdk';

import { CostChart, formatAxisCredits } from './cost-chart';

const twoPoints: CostSeriesPoint[] = [
  { day: '2026-07-01', llm_cost: 1.5, compute_cost: 0.5, total_cost: 2 },
  { day: '2026-07-02', llm_cost: 2, compute_cost: 1, total_cost: 3 },
];

describe('formatAxisCredits', () => {
  test('renders zero as a bare 0', () => {
    expect(formatAxisCredits(0)).toBe('0');
  });

  test('converts USD to whole credits from 10 credits up', () => {
    expect(formatAxisCredits(12.4)).toBe('1,240');
    expect(formatAxisCredits(0.5)).toBe('50');
  });

  test('goes compact from 10,000 credits so the 48px axis never clips', () => {
    expect(formatAxisCredits(1234)).toBe('123.4K');
    expect(formatAxisCredits(100)).toBe('10K');
  });

  test('keeps fractions below 10 credits and a threshold label below 0.01', () => {
    expect(formatAxisCredits(0.001)).toBe('0.1');
    expect(formatAxisCredits(0.00000001)).toBe('<0.01');
  });
});

describe('CostChart', () => {
  test('renders nothing for an empty series — a one-bar chart is noise', () => {
    const html = renderToStaticMarkup(<CostChart series={[]} isLoading={false} />);
    expect(html).toBe('');
  });

  test('renders nothing for a single data point', () => {
    const html = renderToStaticMarkup(<CostChart series={[twoPoints[0]!]} isLoading={false} />);
    expect(html).toBe('');
  });

  test('renders the chart once two or more data points are available', () => {
    const html = renderToStaticMarkup(<CostChart series={twoPoints} isLoading={false} />);
    expect(html).not.toBe('');
    expect(html).toContain('data-slot="chart"');
  });

  test('shows a skeleton while loading, never a spinner icon, even with enough points', () => {
    const html = renderToStaticMarkup(<CostChart series={twoPoints} isLoading={true} />);
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('data-slot="chart"');
    // Matches CostSummaryTiles' aria-label="Loading cost summary" — sibling
    // loading states should not differ in accessibility.
    expect(html).toContain('aria-label="Loading spend chart"');
  });
});
