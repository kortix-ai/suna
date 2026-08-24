import { describe, expect, test } from 'bun:test';

import { groupByDate } from './review-panel';

const DAY = 86_400_000;

/**
 * `groupByDate` used to exist twice — a byte-identical private copy in
 * `change-requests-panel.tsx` and `checkpoints-panel.tsx`, differing only in
 * how each read a timestamp off its item. Neither copy was tested. It is one
 * generic function now, so the buckets are worth pinning once.
 */
const ts = (item: { ts: number }) => item.ts;

/** Noon today — so a "one day earlier" item cannot land back on today
 *  whatever the wall clock says when this runs. */
function noonToday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

describe('groupByDate', () => {
  test('keeps input order within a bucket', () => {
    const noon = noonToday();
    const [group] = groupByDate([{ ts: noon }, { ts: noon - 1_000 }, { ts: noon - 2_000 }], ts);
    expect(group.label).toBe('Today');
    expect(group.items.map((i) => i.ts)).toEqual([noon, noon - 1_000, noon - 2_000]);
  });

  test('buckets today separately from earlier days', () => {
    const noon = noonToday();
    const groups = groupByDate([{ ts: noon }, { ts: noon - DAY }], ts);
    expect(groups[0].label).toBe('Today');
    expect(groups).toHaveLength(2);
    expect(groups[1].label).not.toBe('Today');
  });

  test('falls back to a "Month Year" label well outside this week', () => {
    const old = new Date();
    old.setMonth(old.getMonth() - 3);
    const [group] = groupByDate([{ ts: old.getTime() }], ts);
    expect(group.label).toMatch(/\d{4}/);
    expect(['Today', 'Yesterday', 'This week']).not.toContain(group.label);
  });

  test('emits one group per distinct bucket, in first-seen order', () => {
    const noon = noonToday();
    const old = new Date();
    old.setMonth(old.getMonth() - 3);
    const groups = groupByDate(
      [{ ts: noon }, { ts: old.getTime() }, { ts: noon - 60_000 }],
      ts,
    );
    expect(groups[0].label).toBe('Today');
    expect(groups[0].items).toHaveLength(2);
    expect(groups).toHaveLength(2);
  });

  test('an empty list produces no groups', () => {
    expect(groupByDate([], ts)).toEqual([]);
  });
});
