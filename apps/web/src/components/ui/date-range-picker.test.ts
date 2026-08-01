import { describe, expect, test } from 'bun:test';

import { formatRangeLabel, resolvePreset, toUtcDayRange } from './date-range-picker';

const NOW = new Date('2026-08-01T12:00:00.000Z');

describe('resolvePreset', () => {
  test('7d spans exactly seven days ending now', () => {
    const range = resolvePreset('7d', NOW);
    expect(range.to).toBe('2026-08-01T12:00:00.000Z');
    expect(range.from).toBe('2026-07-25T12:00:00.000Z');
    expect(range.preset).toBe('7d');
  });

  test('24h spans one day', () => {
    expect(resolvePreset('24h', NOW).from).toBe('2026-07-31T12:00:00.000Z');
  });

  test('90d spans ninety days', () => {
    expect(resolvePreset('90d', NOW).from).toBe('2026-05-03T12:00:00.000Z');
  });
});

describe('toUtcDayRange', () => {
  // These Dates are built with the local-midnight constructor
  // `new Date(year, monthIndex, day)`, not `Date.UTC`. That is deliberate:
  // this test process runs in Asia/Calcutta (UTC+5:30, see `TZ`/`date`), so
  // `new Date(2026, 6, 1).toISOString()` is actually '2026-06-30T18:30:00.000Z'
  // — a naive implementation that called `.toISOString()` on the picked Date
  // directly would fail this test with drift. `toUtcDayRange` must instead
  // read the *local* calendar parts (`getFullYear`/`getMonth`/`getDate`) and
  // rebuild the instant with `Date.UTC`, which cancels the host offset.
  test('spans from the start of the first day to the start of the day after the last', () => {
    const range = toUtcDayRange(new Date(2026, 6, 1), new Date(2026, 6, 15));
    expect(range.from).toBe('2026-07-01T00:00:00.000Z');
    expect(range.to).toBe('2026-07-16T00:00:00.000Z');
    expect(range.preset).toBe('custom');
  });

  test('a single-day selection produces a valid 24-hour window', () => {
    const range = toUtcDayRange(new Date(2026, 6, 1), new Date(2026, 6, 1));
    expect(range.from).toBe('2026-07-01T00:00:00.000Z');
    expect(range.to).toBe('2026-07-02T00:00:00.000Z');
  });

  test('rolls a month boundary correctly', () => {
    const range = toUtcDayRange(new Date(2026, 6, 31), new Date(2026, 6, 31));
    expect(range.from).toBe('2026-07-31T00:00:00.000Z');
    expect(range.to).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('formatRangeLabel', () => {
  test('names a preset range', () => {
    expect(formatRangeLabel(resolvePreset('30d', NOW))).toBe('Last 30 days');
  });

  test('shows the inclusive end day the user clicked, not the exclusive to bound', () => {
    // to = '2026-07-16T00:00:00.000Z' is the exclusive day-after boundary for
    // a Jul 1 -> Jul 15 selection; the label must still read "Jul 15", never
    // "Jul 16" — the off-by-one this fix round exists to close.
    const range = toUtcDayRange(new Date(2026, 6, 1), new Date(2026, 6, 15));
    expect(formatRangeLabel(range)).toBe('Jul 1 – Jul 15, 2026');
  });
});
