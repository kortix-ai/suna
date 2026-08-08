import { describe, expect, test } from 'bun:test';

import {
  deltaTone,
  formatAxisUsd,
  formatCount,
  formatDay,
  formatDelta,
  formatUsd,
} from './analytics-format';

describe('formatDay', () => {
  test('renders the UTC calendar day, not the viewer local day', () => {
    // The API buckets by UTC. Parsing `2026-08-07` as local time would shift the
    // label a day west of Greenwich and mislabel every bar on the chart.
    expect(formatDay('2026-08-07')).toBe('Aug 7');
    expect(formatDay('2026-01-01')).toBe('Jan 1');
    expect(formatDay('2026-12-31')).toBe('Dec 31');
  });

  test('passes an unparseable value through instead of rendering "Invalid Date"', () => {
    expect(formatDay('not-a-date')).toBe('not-a-date');
    expect(formatDay('')).toBe('');
  });
});

describe('formatCount', () => {
  test('groups thousands', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});

describe('formatUsd', () => {
  test('renders exact zero as $0, not $0.0000', () => {
    expect(formatUsd(0)).toBe('$0');
  });

  test('keeps four decimals below a dollar so sub-cent burn is not rounded away', () => {
    expect(formatUsd(0.02)).toBe('$0.0200');
    expect(formatUsd(0.4016872)).toBe('$0.4017');
    // The failure this guards: two decimals would print $0.00 for real money.
    expect(formatUsd(0.0003)).toBe('$0.0003');
  });

  test('uses two decimals and thousands separators at or above a dollar', () => {
    expect(formatUsd(1)).toBe('$1');
    expect(formatUsd(1234.5)).toBe('$1,234.5');
    expect(formatUsd(1234.567)).toBe('$1,234.57');
  });
});

describe('formatAxisUsd', () => {
  test('rounds to whole dollars at or above $10 so ticks stay narrow', () => {
    expect(formatAxisUsd(0)).toBe('$0');
    expect(formatAxisUsd(10)).toBe('$10');
    expect(formatAxisUsd(1234.5)).toBe('$1,235');
  });

  test('keeps two decimals below $10 so a small-value axis is uniform and honest', () => {
    // The regression this pins: rounding from $1 up rendered the real recharts
    // tick set 0 / 0.45 / 0.90 / 1.35 / 1.80 as $0 / $0.45 / $0.90 / $1 / $2 —
    // two labels off by up to 26%, on an axis that looked non-uniform.
    expect(formatAxisUsd(0.25)).toBe('$0.25');
    expect(formatAxisUsd(0.45)).toBe('$0.45');
    expect(formatAxisUsd(0.9)).toBe('$0.90');
    expect(formatAxisUsd(1.35)).toBe('$1.35');
    expect(formatAxisUsd(1.8)).toBe('$1.80');
    expect(formatAxisUsd(9.99)).toBe('$9.99');
  });

  test('every tick in a real small-value axis renders a distinct label', () => {
    const ticks = [0, 0.45, 0.9, 1.35, 1.8].map(formatAxisUsd);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks).toEqual(['$0', '$0.45', '$0.90', '$1.35', '$1.80']);
  });
});

describe('formatDelta', () => {
  test('returns null when there is no baseline to compare against', () => {
    // 0 -> 5 is not "+100%"; there is no percentage change from nothing.
    expect(formatDelta(5, 0)).toBeNull();
    expect(formatDelta(0, 0)).toBeNull();
    expect(formatDelta(5, -3)).toBeNull();
  });

  test('signs growth and decline', () => {
    expect(formatDelta(150, 100)).toBe('+50% vs prev 7d');
    expect(formatDelta(50, 100)).toBe('-50% vs prev 7d');
  });

  test('says "flat" instead of "+0%" / "-0%"', () => {
    expect(formatDelta(100, 100)).toBe('flat vs prev 7d');
    // -0.2% rounds to -0, which must read as flat, not "-0% vs prev 7d".
    expect(formatDelta(1000, 1002)).toBe('flat vs prev 7d');
    expect(formatDelta(1002, 1000)).toBe('flat vs prev 7d');
  });

  test('a change large enough to round to a whole percent is NOT reported flat', () => {
    expect(formatDelta(100, 101)).toBe('-1% vs prev 7d');
  });
});

describe('deltaTone', () => {
  test('is neutral without a baseline', () => {
    expect(deltaTone(5, 0)).toBe('default');
  });

  test('growth is success, decline is warning, equal is neutral', () => {
    expect(deltaTone(150, 100)).toBe('success');
    expect(deltaTone(50, 100)).toBe('warning');
    expect(deltaTone(100, 100)).toBe('default');
  });
});
