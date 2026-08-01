import { describe, expect, test } from 'bun:test';

import { formatRangeLabel, resolvePreset, toCalendarSelection, toUtcDayRange } from './date-range-picker';

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
  // `new Date(year, monthIndex, day)`, not `Date.UTC`. That is a realistic
  // fixture — it's exactly what react-day-picker hands back — and, since
  // this process runs in Asia/Calcutta (UTC+5:30, see `TZ`/`date`), it does
  // exercise real timezone-drift correction on THIS host. It is not a
  // reliable regression guard on every host, though: on a UTC+0 CI runner,
  // local midnight already equals UTC midnight, so a naive implementation
  // that just called `.toISOString()` on the picked Date directly would
  // produce byte-identical output here and the assertions below would not
  // catch it. See the dedicated host-independent test at the bottom of this
  // block for the guard that holds on every host.
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

  test('reads the local calendar day rather than the Date\'s own instant, on every host', () => {
    // A Date whose real underlying instant is Jan 1, with getFullYear/
    // getMonth/getDate overridden to report Jul 1. toUtcDayRange must call
    // those local getters (as the implementation does) rather than fall
    // back to `.toISOString()` on the Date itself (what the pre-fix
    // implementation did) — `.toISOString()` always reads the real Jan 1
    // instant, which is host-TZ-independent, so this distinguishes correct
    // from buggy on every host, including UTC+0, unlike the fixtures above.
    const fakePickedDay = new Date('2026-01-01T00:00:00.000Z');
    fakePickedDay.getFullYear = () => 2026;
    fakePickedDay.getMonth = () => 6;
    fakePickedDay.getDate = () => 1;

    const range = toUtcDayRange(fakePickedDay, fakePickedDay);
    expect(range.from).toBe('2026-07-01T00:00:00.000Z');
    expect(range.to).toBe('2026-07-02T00:00:00.000Z');
  });
});

describe('toCalendarSelection', () => {
  test('a custom range highlights through the inclusive end day, not the exclusive to bound', () => {
    const selection = toCalendarSelection({
      preset: 'custom',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-16T00:00:00.000Z',
    });
    expect(selection.to.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  test('a preset range is passed through unchanged', () => {
    const value = resolvePreset('7d', NOW);
    const selection = toCalendarSelection(value);
    expect(selection.from.toISOString()).toBe(value.from);
    expect(selection.to.toISOString()).toBe(value.to);
  });

  test('a single-day custom range highlights exactly one day', () => {
    const selection = toCalendarSelection({
      preset: 'custom',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
    });
    expect(selection.to.toISOString()).toBe(selection.from.toISOString());
  });

  test('is the exact inverse of toUtcDayRange', () => {
    const start = new Date(2026, 6, 1);
    const end = new Date(2026, 6, 15);
    const selection = toCalendarSelection(toUtcDayRange(start, end));

    expect([
      selection.from.getFullYear(),
      selection.from.getMonth(),
      selection.from.getDate(),
    ]).toEqual([start.getFullYear(), start.getMonth(), start.getDate()]);
    expect([
      selection.to.getFullYear(),
      selection.to.getMonth(),
      selection.to.getDate(),
    ]).toEqual([end.getFullYear(), end.getMonth(), end.getDate()]);
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
