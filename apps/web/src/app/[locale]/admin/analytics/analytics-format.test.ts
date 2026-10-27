import { describe, expect, test } from 'bun:test';

import {
  deltaTone,
  formatAxisCredits,
  formatCount,
  formatCredits,
  formatDay,
  formatDelta,
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

describe('formatCredits', () => {
  test('renders exact zero as 0', () => {
    expect(formatCredits(0)).toBe('0');
  });

  test('keeps two decimals below 10 credits so sub-cent burn is not rounded away', () => {
    expect(formatCredits(0.02)).toBe('2');
    expect(formatCredits(0.004016872)).toBe('0.4');
    // The failure this guards: a whole-credit round would print 0 for real spend.
    expect(formatCredits(0.0003)).toBe('0.03');
    expect(formatCredits(0.00000003)).toBe('<0.01');
  });

  test('uses whole credits and thousands separators from 10 credits up', () => {
    expect(formatCredits(1)).toBe('100');
    expect(formatCredits(1234.5)).toBe('123,450');
    expect(formatCredits(1234.567)).toBe('123,457');
  });

  test('formats in the viewer locale when given one', () => {
    expect(formatCredits(1234.5, 'de-DE')).toBe('123.450');
  });
});

describe('formatAxisCredits', () => {
  test('rounds to whole credits at or above 10 so ticks stay narrow', () => {
    expect(formatAxisCredits(0)).toBe('0');
    expect(formatAxisCredits(0.1)).toBe('10');
    expect(formatAxisCredits(1234.5)).toBe('123,450');
  });

  test('keeps two decimals below 10 credits so a small-value axis is uniform and honest', () => {
    // The regression this pins: rounding a small tick set 0 / 0.45 / 0.90 /
    // 1.35 / 1.80 to whole units rendered labels off by up to 26%.
    expect(formatAxisCredits(0.0025)).toBe('0.25');
    expect(formatAxisCredits(0.0045)).toBe('0.45');
    expect(formatAxisCredits(0.009)).toBe('0.90');
    expect(formatAxisCredits(0.0135)).toBe('1.35');
    expect(formatAxisCredits(0.018)).toBe('1.80');
    expect(formatAxisCredits(0.0999)).toBe('9.99');
  });

  test('every tick in a real small-value axis renders a distinct label', () => {
    const ticks = [0, 0.0045, 0.009, 0.0135, 0.018].map((usd) => formatAxisCredits(usd));
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks).toEqual(['0', '0.45', '0.90', '1.35', '1.80']);
  });

  test('a USD tick set from the burn chart reads as whole credits', () => {
    expect([0, 0.45, 0.9, 1.35, 1.8].map((usd) => formatAxisCredits(usd))).toEqual([
      '0',
      '45',
      '90',
      '135',
      '180',
    ]);
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
