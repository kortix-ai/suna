import type { ProjectReminder } from '@kortix/sdk';
import { expandFires, isFrequent, type ReminderFire } from './reminder-schedule';
import type { RemindersRange } from './use-reminders-url-state';

/**
 * Pure date math for the Calendar view. Every date is a local midnight
 * `Date`; `now` is a parameter so tests and renders agree.
 */

export const DAY_MINUTES = 24 * 60;

const DATE_PARAM = /^(\d{4})-(\d{2})-(\d{2})$/;

export const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

export const startOfDay = (at: number | Date) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

export const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Monday 0 … Sunday 6. */
export const weekdayIndex = (date: Date) => (date.getDay() + 6) % 7;

export const startOfWeek = (date: Date) => addDays(startOfDay(date), -weekdayIndex(date));

/** `?date=` value for a day: local `YYYY-MM-DD`. */
export function dateParam(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The calendar anchor from `?date=`; a missing or invalid value is today. */
export function parseDateParam(value: string | null, now: number): Date {
  const match = value ? DATE_PARAM.exec(value) : null;
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (dateParam(date) === value) return date;
  }
  return startOfDay(now);
}

/**
 * The days on screen: a Monday-first week, or a month as whole Monday-first
 * weeks (5 or 6 rows; 4 only for a February that starts on a Monday).
 */
export function rangeDays(anchor: Date, range: RemindersRange): Date[] {
  if (range === 'week') {
    const monday = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const weeks = Math.ceil((weekdayIndex(first) + last.getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

/** The anchor one week or one month on (`step` 1) or back (-1). A month lands on its 1st. */
export function shiftAnchor(anchor: Date, range: RemindersRange, step: 1 | -1): Date {
  return range === 'week'
    ? addDays(anchor, step * 7)
    : new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
}

/** "5 – 11 October 2026" (week, locale order) or "October 2026" (month). */
export function rangeLabel(anchor: Date, range: RemindersRange, locale: string): string {
  if (range === 'month') {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);
  }
  const monday = startOfWeek(anchor);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).formatRange(
    monday,
    addDays(monday, 6),
  );
}

/** "14:00": the calendar is a 24-hour grid, so its times are 24-hour in every locale. */
export const clockTime = (at: number | Date, locale: string) =>
  new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "in 30 min", "in 3 hr", "in 2 days", "5 min ago". */
export function relativeFire(at: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const minutes = Math.round((at - now) / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  if (Math.abs(minutes) < DAY_MINUTES) return rtf.format(Math.round(minutes / 60), 'hour');
  return rtf.format(Math.round(minutes / DAY_MINUTES), 'day');
}

export const minutesOfDay = (at: number) => {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
};

export type ChipLayout = { fire: ReminderFire; top: number; lane: number; lanes: number };

/**
 * Side-by-side lanes for chips that would overlap in one day column. A chip
 * covers `span` minutes from its fire; chips that overlap, directly or through
 * a chain, share a cluster and split its width evenly.
 */
export function layoutChips(fires: readonly ReminderFire[], span: number): ChipLayout[] {
  const out: ChipLayout[] = [];
  let cluster: ChipLayout[] = [];
  let laneEnds: number[] = [];
  const close = () => {
    for (const chip of cluster) chip.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const fire of [...fires].sort((a, b) => a.at - b.at)) {
    const top = minutesOfDay(fire.at);
    if (cluster.length > 0 && top >= Math.max(...laneEnds)) close();
    let lane = laneEnds.findIndex((end) => end <= top);
    if (lane === -1) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = top + span;
    const chip = { fire, top, lane, lanes: 1 };
    cluster.push(chip);
    out.push(chip);
  }
  close();
  return out;
}

export type DayGroup = { reminder: ProjectReminder; first: number; count: number };

export type CalendarDay = {
  date: Date;
  /** One chip per fire: every fire of a reminder that is not frequent. */
  chips: ReminderFire[];
  /** All of the day's fires, one entry per reminder, by first fire. */
  groups: DayGroup[];
  /** Every fire this day, frequent reminders included. */
  total: number;
};

export type CalendarModel = {
  days: CalendarDay[];
  /** Frequent reminders with a fire on screen, and their first upcoming (else first) fire. */
  frequent: { reminder: ProjectReminder; fire: ReminderFire }[];
  total: number;
};

/**
 * Fires per day for the days on screen. Expanded one day at a time:
 * `expandFires` caps each reminder at 2000 fires per call, and a 5-minute
 * reminder makes 288 a day. Frequent reminders are counted, never chipped.
 */
export function calendarModel(
  reminders: readonly ProjectReminder[],
  days: readonly Date[],
  now: number,
): CalendarModel {
  const frequent = new Map<string, { reminder: ProjectReminder; fire: ReminderFire }>();
  let total = 0;
  const out = days.map((date): CalendarDay => {
    const fires = expandFires(reminders, date.getTime(), addDays(date, 1).getTime(), now);
    const groups = new Map<string, DayGroup>();
    const chips: ReminderFire[] = [];
    for (const fire of fires) {
      const { reminder } = fire;
      const group = groups.get(reminder.id) ?? { reminder, first: fire.at, count: 0 };
      group.count++;
      groups.set(reminder.id, group);
      if (!isFrequent(reminder)) {
        chips.push(fire);
        continue;
      }
      const seen = frequent.get(reminder.id);
      if (!seen || (seen.fire.past && !fire.past)) frequent.set(reminder.id, { reminder, fire });
    }
    total += fires.length;
    return { date, chips, groups: [...groups.values()], total: fires.length };
  });
  return { days: out, frequent: [...frequent.values()], total };
}
