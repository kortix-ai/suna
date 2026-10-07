import { describe, expect, test } from 'bun:test';
import type { ProjectReminder } from '@kortix/sdk';
import {
  calendarModel,
  clockTime,
  dateParam,
  layoutChips,
  parseDateParam,
  rangeDays,
  rangeLabel,
  relativeFire,
  shiftAnchor,
  startOfWeek,
} from './reminder-calendar-model';
import type { ReminderFire } from './reminder-schedule';

// Local-time fixtures, so the suite passes in any TZ.
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
// Wednesday 7 October 2026, 13:30.
const NOW = local(2026, 10, 7, 13, 30).getTime();
const MIN = 60_000;

function reminder(over: Partial<ProjectReminder>): ProjectReminder {
  return {
    id: 'r1',
    session_id: 's1',
    session_name: null,
    name: null,
    prompt: 'ping',
    every: null,
    every_seconds: null,
    cron: null,
    timezone: null,
    at: null,
    state: 'active',
    next_fire_at: null,
    last_fired_at: null,
    last_status: null,
    last_error: null,
    created_by: null,
    created_at: local(2026, 9, 1).toISOString(),
    ...over,
  } as ProjectReminder;
}

describe('anchor dates', () => {
  test('a valid ?date= is that local day; missing or invalid is today', () => {
    expect(dateParam(parseDateParam('2026-02-28', NOW))).toBe('2026-02-28');
    expect(dateParam(parseDateParam(null, NOW))).toBe('2026-10-07');
    expect(dateParam(parseDateParam('2026-02-30', NOW))).toBe('2026-10-07');
    expect(dateParam(parseDateParam('7 Oct', NOW))).toBe('2026-10-07');
  });

  test('weeks start on Monday, Sunday included', () => {
    expect(dateParam(startOfWeek(local(2026, 10, 7)))).toBe('2026-10-05');
    expect(dateParam(startOfWeek(local(2026, 10, 11)))).toBe('2026-10-05');
    expect(dateParam(startOfWeek(local(2026, 10, 5)))).toBe('2026-10-05');
  });

  test('week range is Mon..Sun around the anchor', () => {
    const days = rangeDays(local(2026, 10, 7), 'week').map(dateParam);
    expect(days).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
  });

  test('month range is whole Monday-first weeks: 5 or 6 rows', () => {
    // October 2026 starts on a Thursday: 3 + 31 = 34 cells → 5 weeks.
    const october = rangeDays(local(2026, 10, 20), 'month');
    expect(october).toHaveLength(35);
    expect(dateParam(october[0]!)).toBe('2026-09-28');
    expect(dateParam(october[34]!)).toBe('2026-11-01');
    // August 2026 starts on a Saturday: 5 + 31 = 36 cells → 6 weeks.
    const august = rangeDays(local(2026, 8, 1), 'month');
    expect(august).toHaveLength(42);
    expect(dateParam(august[0]!)).toBe('2026-07-27');
    expect(dateParam(august[41]!)).toBe('2026-09-06');
  });

  test('prev/next move a week, or a month to its 1st (no 31st overflow)', () => {
    expect(dateParam(shiftAnchor(local(2026, 10, 7), 'week', 1))).toBe('2026-10-14');
    expect(dateParam(shiftAnchor(local(2026, 10, 7), 'week', -1))).toBe('2026-09-30');
    expect(dateParam(shiftAnchor(local(2026, 1, 31), 'month', 1))).toBe('2026-02-01');
    expect(dateParam(shiftAnchor(local(2026, 1, 31), 'month', -1))).toBe('2025-12-01');
  });
});

describe('labels', () => {
  test('range label via Intl in the locale', () => {
    expect(rangeLabel(local(2026, 10, 7), 'week', 'en-GB')).toBe('5 – 11 October 2026');
    expect(rangeLabel(local(2026, 10, 7), 'month', 'en-GB')).toBe('October 2026');
    expect(rangeLabel(local(2026, 10, 7), 'month', 'de')).toBe('Oktober 2026');
  });

  test('clock time is 24-hour; relative time scales minute → hour → day', () => {
    expect(clockTime(local(2026, 10, 7, 14), 'en')).toBe('14:00');
    expect(relativeFire(NOW + 30 * MIN, NOW, 'en')).toBe('in 30 min.');
    expect(relativeFire(NOW + 180 * MIN, NOW, 'en')).toBe('in 3 hr.');
    expect(relativeFire(NOW + 2 * 1440 * MIN, NOW, 'en')).toBe('in 2 days');
    expect(relativeFire(NOW - 5 * MIN, NOW, 'en')).toBe('5 min. ago');
  });
});

describe('layoutChips', () => {
  const fire = (h: number, m: number): ReminderFire => ({
    reminder: reminder({}),
    at: local(2026, 10, 7, h, m).getTime(),
    past: false,
    confirmed: false,
  });

  test('apart chips each take the full width', () => {
    const chips = layoutChips([fire(9, 0), fire(14, 0)], 30);
    expect(chips.map((c) => [c.top, c.lane, c.lanes])).toEqual([
      [540, 0, 1],
      [840, 0, 1],
    ]);
  });

  test('overlapping chips split a cluster; a free lane is reused', () => {
    const chips = layoutChips([fire(9, 20), fire(9, 0), fire(9, 10), fire(9, 35), fire(11, 0)], 30);
    expect(chips.map((c) => [c.top, c.lane, c.lanes])).toEqual([
      [540, 0, 3],
      [550, 1, 3],
      [560, 2, 3],
      [575, 0, 3],
      [660, 0, 1],
    ]);
  });
});

describe('calendarModel', () => {
  const week = rangeDays(local(2026, 10, 7), 'week');

  test('a one-shot reminder is one chip on its day', () => {
    const at = local(2026, 10, 8, 9);
    const model = calendarModel([reminder({ next_fire_at: at.toISOString() })], week, NOW);
    expect(model.total).toBe(1);
    expect(model.days[3]!.chips.map((f) => f.at)).toEqual([at.getTime()]);
    expect(model.days.map((d) => d.total)).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(model.frequent).toEqual([]);
  });

  test('a frequent reminder is counted per day, never chipped, and lane-listed once', () => {
    // Every 5 minutes, created Monday 00:00, next fire 13:35 today.
    const r = reminder({
      id: 'often',
      every: '5m',
      every_seconds: 300,
      next_fire_at: local(2026, 10, 7, 13, 35).toISOString(),
      created_at: local(2026, 10, 5).toISOString(),
    });
    const model = calendarModel([r], week, NOW);
    expect(model.days.every((d) => d.chips.length === 0)).toBe(true);
    // Mon/Tue full past days, then every later day full: 288 a day.
    expect(model.days.map((d) => d.total)).toEqual([288, 288, 288, 288, 288, 288, 288]);
    expect(model.days[2]!.groups).toEqual([{ reminder: r, first: local(2026, 10, 7).getTime(), count: 288 }]);
    expect(model.frequent).toHaveLength(1);
    // The lane's fire is the first upcoming one, not Monday 00:00.
    expect(model.frequent[0]!.fire.at).toBe(local(2026, 10, 7, 13, 35).getTime());
  });

  test('a month window with a 5-minute reminder is not capped at 2000 fires', () => {
    const r = reminder({
      every_seconds: 300,
      next_fire_at: local(2026, 10, 7, 13, 35).toISOString(),
      created_at: local(2026, 9, 1).toISOString(),
    });
    const month = rangeDays(local(2026, 10, 7), 'month');
    const model = calendarModel([r], month, NOW);
    // 288 a day, more or less on a DST-change day in the runner's TZ.
    const expected = month.reduce((sum, day) => {
      const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      return sum + (next.getTime() - day.getTime()) / (5 * MIN);
    }, 0);
    expect(model.total).toBe(expected);
    expect(model.total).toBeGreaterThan(2000);
  });

  test('a daily reminder chips every day; past fires are marked past', () => {
    const r = reminder({
      every: '1d',
      every_seconds: 86_400,
      next_fire_at: local(2026, 10, 8, 9).toISOString(),
      created_at: local(2026, 9, 1).toISOString(),
    });
    const model = calendarModel([r], week, NOW);
    expect(model.days.map((d) => d.chips.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(model.days.map((d) => d.chips[0]!.past)).toEqual([true, true, true, false, false, false, false]);
  });
});
