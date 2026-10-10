import type { ProjectReminder } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  calendarModel,
  clockTime,
  dateParam,
  daysBetween,
  focusMonth,
  layoutChips,
  monthEntries,
  nearEdge,
  parseDateParam,
  rangeLabel,
  relativeFire,
  startOfWeek,
  windowDays,
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

  test('Week window: 28 days either side of the anchor, then 7 more', () => {
    const days = windowDays(local(2026, 10, 7, 15), 'week');
    expect(days).toHaveLength(63);
    expect(dateParam(days[0]!)).toBe('2026-09-09');
    expect(dateParam(days[28]!)).toBe('2026-10-07');
    expect(dateParam(days[62]!)).toBe('2026-11-10');
  });

  test('Month window: 12 Monday-first weeks either side of the anchor week', () => {
    const days = windowDays(local(2026, 10, 7), 'month');
    expect(days).toHaveLength(25 * 7);
    expect(dateParam(days[0]!)).toBe('2026-07-13');
    expect(dateParam(days[12 * 7]!)).toBe('2026-10-05');
    expect(days.filter((_, i) => i % 7 === 0).every((d) => d.getDay() === 1)).toBe(true);
  });

  test('daysBetween counts calendar days, across a DST change too', () => {
    expect(daysBetween(local(2026, 10, 7, 23), local(2026, 10, 8, 1))).toBe(1);
    expect(daysBetween(local(2026, 3, 20), local(2026, 4, 10))).toBe(21);
    expect(daysBetween(local(2026, 11, 10), local(2026, 10, 20))).toBe(-21);
  });

  test('nearEdge: re-centre within 12 days (Week) or 5 weeks (Month) of the window edge', () => {
    const origin = local(2026, 10, 7);
    expect(nearEdge(local(2026, 10, 23), origin, 'week')).toBe(false);
    expect(nearEdge(local(2026, 10, 24), origin, 'week')).toBe(true);
    expect(nearEdge(local(2026, 9, 20), origin, 'week')).toBe(true);
    // 7 weeks on is inside; 8 weeks on is within 5 of the 12-week edge.
    expect(nearEdge(local(2026, 11, 23), origin, 'month')).toBe(false);
    expect(nearEdge(local(2026, 11, 30), origin, 'month')).toBe(true);
  });

  test('a week belongs to the month of its Thursday', () => {
    // Mon 28 Sep – Sun 4 Oct 2026: Thursday 1 Oct.
    expect(dateParam(focusMonth(local(2026, 9, 28)))).toBe('2026-10-01');
    // Mon 27 Jul – Sun 2 Aug 2026: Thursday 30 Jul.
    expect(dateParam(focusMonth(local(2026, 8, 2)))).toBe('2026-07-01');
  });
});

describe('labels', () => {
  test('range label via Intl in the locale', () => {
    // Week: 7 days from the first visible day, which need not be a Monday.
    expect(rangeLabel(local(2026, 10, 7), 'week', 'en-GB')).toBe('7 – 13 October 2026');
    expect(rangeLabel(local(2026, 10, 7), 'month', 'en-GB')).toBe('October 2026');
    expect(rangeLabel(local(2026, 10, 7), 'month', 'de')).toBe('Oktober 2026');
    // Month: the top week's month, not the Monday's.
    expect(rangeLabel(local(2026, 9, 28), 'month', 'en-GB')).toBe('October 2026');
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

  test('a lone chip with free room below is drawn tall; a crowded one stays short', () => {
    const chips = layoutChips([fire(9, 0), fire(9, 45), fire(14, 0), fire(23, 30)], 30, 60);
    expect(chips.map((c) => c.span)).toEqual([30, 60, 60, 30]);
  });
});

describe('calendarModel', () => {
  const week = Array.from({ length: 7 }, (_, i) => local(2026, 10, 5 + i));

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
    // A day's group keeps its first upcoming fire: 13:35 today, not 00:00.
    expect(model.days[2]!.groups.map((g) => [g.fire.at, g.count])).toEqual([
      [local(2026, 10, 7, 13, 35).getTime(), 288],
    ]);
    expect(model.days[1]!.groups[0]!.fire.at).toBe(local(2026, 10, 6).getTime());
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
    const month = Array.from({ length: 35 }, (_, i) => local(2026, 9, 28 + i));
    const model = calendarModel([r], month, NOW);
    // 288 a day, more or less on a DST-change day in the runner's TZ.
    const expected = month.reduce((sum, day) => {
      const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      return sum + (next.getTime() - day.getTime()) / (5 * MIN);
    }, 0);
    expect(model.total).toBe(expected);
    expect(model.total).toBeGreaterThan(2000);
  });

  test('a clock tick rebuilds only the days the clock can change', () => {
    const daily = reminder({
      every_seconds: 86_400,
      next_fire_at: local(2026, 10, 8, 9).toISOString(),
    });
    const first = calendarModel([daily], week, NOW);
    const later = calendarModel([daily], week, NOW + MIN, first);
    // Mon and Tue were past, Thu-Sun are future: reused. Today is rebuilt.
    expect(later.days.map((d, i) => d === first.days[i])).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
      true,
    ]);
    // And the reused days hold exactly what a full rebuild would.
    expect(later).toEqual(calendarModel([daily], week, NOW + MIN));
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
    expect(model.days.map((d) => d.chips[0]!.past)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('monthEntries', () => {
  test('fires and one line per frequent reminder, by time', () => {
    const often = reminder({
      id: 'often',
      every_seconds: 1800,
      next_fire_at: local(2026, 10, 8).toISOString(),
      created_at: local(2026, 9, 1).toISOString(),
    });
    const daily = reminder({
      id: 'daily',
      every_seconds: 86_400,
      next_fire_at: local(2026, 10, 8, 9).toISOString(),
    });
    const once = reminder({ id: 'once', next_fire_at: local(2026, 10, 8, 7).toISOString() });
    const model = calendarModel([often, daily, once], [local(2026, 10, 8)], NOW);
    const lines = monthEntries(model.days[0]!).map((e) => [e.fire.reminder.id, e.count]);
    expect(lines).toEqual([
      ['often', 48],
      ['once', null],
      ['daily', null],
    ]);
  });
});
