import { describe, expect, test } from 'bun:test';

import {
  formatRangeLabel,
  nextRangeDraft,
  resolvePreset,
  toCalendarSelection,
  toUtcDayRange,
  WIDEST_RANGE_LABEL,
} from './date-range-picker';

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

/**
 * A `Date` whose local `getFullYear`/`getMonth`/`getDate` are pinned to
 * given values regardless of the host's real timezone, while its own
 * instant (and `toISOString()`) stays an unrelated, real value. This is the
 * only way to write a test that is host-TZ-independent *by construction*:
 * `toISOString()` is always UTC (so it can never expose whether an
 * implementation reads local calendar parts correctly), and an ordinary
 * `new Date(year, month, date)` fixture only reveals a local/UTC mismatch on
 * a host whose offset happens to push across a day boundary.
 */
function fakeLocalDay(year: number, month: number, date: number): Date {
  const fake = new Date('2026-01-01T00:00:00.000Z'); // arbitrary, unrelated instant
  fake.getFullYear = () => year;
  fake.getMonth = () => month;
  fake.getDate = () => date;
  return fake;
}

const dayParts = (date: Date): [number, number, number] => [
  date.getFullYear(),
  date.getMonth(),
  date.getDate(),
];

describe('toCalendarSelection', () => {
  test('a custom range highlights through the inclusive end day, not the exclusive to bound', () => {
    const selection = toCalendarSelection({
      preset: 'custom',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-16T00:00:00.000Z',
    });
    expect(dayParts(selection.from)).toEqual([2026, 6, 1]);
    expect(dayParts(selection.to)).toEqual([2026, 6, 15]);
  });

  test('a preset range is passed through unchanged', () => {
    const value = resolvePreset('7d', NOW);
    const selection = toCalendarSelection(value);
    // Presets are real instants (`to` is `now`), not calendar-day
    // boundaries, so an exact instant comparison is the correct assertion
    // here — unlike the custom-range cases, there is no local/UTC ambiguity
    // to guard against for a value that's passed through unmodified.
    expect(selection.from.toISOString()).toBe(value.from);
    expect(selection.to.toISOString()).toBe(value.to);
  });

  test('a single-day custom range highlights exactly one day', () => {
    const selection = toCalendarSelection({
      preset: 'custom',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
    });
    expect(dayParts(selection.to)).toEqual(dayParts(selection.from));
  });

  test('is the exact inverse of toUtcDayRange across a multi-day range, a single day, a month boundary, and a year boundary', () => {
    // Each case's start/end is built with fakeLocalDay rather than the
    // ambient `new Date(y, m, d)` constructor, so the invariant is checked
    // regardless of the host's real timezone, not merely on this test
    // process's own (Asia/Calcutta) offset.
    const cases: Array<{
      start: [number, number, number];
      end: [number, number, number];
    }> = [
      { start: [2026, 6, 1], end: [2026, 6, 15] }, // multi-day range
      { start: [2026, 6, 1], end: [2026, 6, 1] }, // single day
      { start: [2026, 6, 31], end: [2026, 6, 31] }, // month boundary (Jul 31)
      { start: [2026, 11, 31], end: [2026, 11, 31] }, // year boundary (Dec 31)
    ];

    for (const { start, end } of cases) {
      const range = toUtcDayRange(fakeLocalDay(...start), fakeLocalDay(...end));
      const selection = toCalendarSelection(range);
      expect(dayParts(selection.from)).toEqual(start);
      expect(dayParts(selection.to)).toEqual(end);
    }
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

// ── WIDEST_RANGE_LABEL ─────────────────────────────────────────────────────
//
// The trigger reserves this string's rendered width so the control does not
// resize as the range changes. That reservation is only correct while the
// string really is the widest thing `formatRangeLabel` can produce, and the
// formatter can change under it — so the claim is checked against the
// formatter's actual output over its whole input space rather than asserted by
// inspection.
//
// The whole space is enumerable: four presets, and a custom range that is
// `MMM D – MMM D, YYYY` for every ordered pair of the twelve months. Length in
// characters is the right measure here (not px) because the shape is fixed and
// the digits render `tabular-nums`, so two labels of equal length differ only
// in month names — and the check below pins the month-name width too.

describe('WIDEST_RANGE_LABEL', () => {
  /** Every custom label the formatter can emit at its widest day numbers:
   *  each ordered month pair, two-digit day to two-digit day. Two end days per
   *  pair — `to` is the exclusive day-after bound, so `endDay + 1` renders
   *  `endDay` as the inclusive end day the label shows. */
  function everyWidestCustomLabel(): string[] {
    const labels: string[] = [];
    for (let startMonth = 0; startMonth < 12; startMonth += 1) {
      for (let endMonth = 0; endMonth < 12; endMonth += 1) {
        for (const endDay of [28, 30]) {
          labels.push(
            formatRangeLabel({
              preset: 'custom',
              from: new Date(Date.UTC(2026, startMonth, 28)).toISOString(),
              to: new Date(Date.UTC(2026, endMonth, endDay + 1)).toISOString(),
            }),
          );
        }
      }
    }
    return labels;
  }

  test('is itself a label the formatter emits — not an invented string', () => {
    expect(everyWidestCustomLabel()).toContain(WIDEST_RANGE_LABEL);
  });

  test('no preset label is longer', () => {
    for (const preset of ['24h', '7d', '30d', '90d'] as const) {
      const label = formatRangeLabel(resolvePreset(preset, NOW));
      expect(label.length, `preset ${preset} rendered "${label}"`).toBeLessThanOrEqual(
        WIDEST_RANGE_LABEL.length,
      );
    }
  });

  test('no custom-range label is longer, across every month pair', () => {
    for (const label of everyWidestCustomLabel()) {
      expect(label.length, `custom range rendered "${label}"`).toBeLessThanOrEqual(
        WIDEST_RANGE_LABEL.length,
      );
    }
  });

  // The reservation assumes every month abbreviation occupies the same three
  // characters, which is what makes a single sizing string cover all twelve.
  // An `en-US` locale change that emitted `Sept` would break that silently.
  test('every month abbreviation the formatter emits is exactly three characters', () => {
    const months = new Set<string>();
    for (let month = 0; month < 12; month += 1) {
      const label = formatRangeLabel({
        preset: 'custom',
        from: new Date(Date.UTC(2026, month, 28)).toISOString(),
        to: new Date(Date.UTC(2026, month, 29)).toISOString(),
      });
      months.add(label.slice(0, label.indexOf(' ')));
    }
    expect(months.size).toBe(12);
    for (const month of months) expect(month).toHaveLength(3);
  });

  // A year-boundary range is the case the width reservation is most often
  // assumed to be about. It is NOT the worst case: the formatter prints the
  // year once, at the end, so `Dec 28 – Jan 3, 2027` is shorter than a
  // same-year two-digit/two-digit range. Pinned so nobody re-sizes the trigger
  // to a `Dec 28, 2026 – Jan 3, 2027` shape this control never produces.
  test('a range spanning a year boundary is shorter than the reserved width, not longer', () => {
    const label = formatRangeLabel({
      preset: 'custom',
      from: '2026-12-28T00:00:00.000Z',
      to: '2027-01-04T00:00:00.000Z',
    });
    expect(label).toBe('Dec 28 – Jan 3, 2027');
    expect(label.length).toBeLessThan(WIDEST_RANGE_LABEL.length);
  });
});

describe('nextRangeDraft', () => {
  const day = (n: number) => new Date(2026, 6, n);

  // The bug this function exists for. Before the fix the picker passed
  // react-day-picker's own range straight through, and because `selected` is
  // always a complete range, one click came back complete — so the popover
  // committed and closed before a second date could be chosen.
  test('the first click opens a range instead of completing one', () => {
    const step = nextRangeDraft(undefined, day(10));
    expect(step.kind).toBe('pending');
    if (step.kind !== 'pending') throw new Error('expected pending');
    expect(step.draft.from).toEqual(day(10));
    expect(step.draft.to).toBeUndefined();
  });

  test('a click after a committed range still opens rather than extends it', () => {
    // `draft` is undefined whenever nothing is mid-selection, no matter what
    // range is committed — so this is the same path as a fresh open.
    const step = nextRangeDraft(undefined, day(20));
    expect(step.kind).toBe('pending');
  });

  test('the second click completes the range', () => {
    const step = nextRangeDraft({ from: day(10), to: undefined }, day(15));
    expect(step).toEqual({ kind: 'complete', from: day(10), to: day(15) });
  });

  test('clicking backwards completes in calendar order, not click order', () => {
    const step = nextRangeDraft({ from: day(15), to: undefined }, day(10));
    expect(step).toEqual({ kind: 'complete', from: day(10), to: day(15) });
  });

  test('clicking the same day twice is a one-day range, not a stuck draft', () => {
    const step = nextRangeDraft({ from: day(10), to: undefined }, day(10));
    expect(step).toEqual({ kind: 'complete', from: day(10), to: day(10) });
  });

  test('a completed draft starts over rather than editing itself', () => {
    const step = nextRangeDraft({ from: day(10), to: day(15) }, day(20));
    expect(step.kind).toBe('pending');
    if (step.kind !== 'pending') throw new Error('expected pending');
    expect(step.draft.from).toEqual(day(20));
    expect(step.draft.to).toBeUndefined();
  });

  test('a one-day completion survives the half-open conversion', () => {
    const step = nextRangeDraft({ from: day(10), to: undefined }, day(10));
    if (step.kind !== 'complete') throw new Error('expected complete');
    const range = toUtcDayRange(step.from, step.to);
    // [from, to) over a single day is that day's midnight to the next.
    expect(new Date(range.to).getTime() - new Date(range.from).getTime()).toBe(86_400_000);
  });
});
