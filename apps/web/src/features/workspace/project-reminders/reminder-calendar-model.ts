import type { ProjectReminder } from '@kortix/sdk';
import { expandFires, fireStats, isFrequent, type ReminderFire } from './reminder-schedule';
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
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

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

/** Days between two local dates (DST-safe: rounds the hour a clock change adds). */
export const daysBetween = (from: Date, to: Date) =>
  Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);

/**
 * Days rendered either side of the origin: 12 weeks (Month) or 28 days (Week).
 * Every rendered day costs mount time, so the window is a few screens each way
 * and moves with the scroll instead of covering a year.
 */
const WINDOW: Record<RemindersRange, number> = { month: 12 * 7, week: 28 };
/** Once the scroll settles this close to an edge, in days, the window re-centres. */
const EDGE: Record<RemindersRange, number> = { month: 5 * 7, week: 12 };

/** The row (Month: a week, from its Monday) or column (Week: a day) at the top-left for `date`. */
export const topOf = (date: Date, range: RemindersRange) =>
  range === 'month' ? startOfWeek(date) : startOfDay(date);

/**
 * The scrollable window around `origin`: Monday-first weeks for Month
 * (25 rows), consecutive days for Week (63 columns, so the last 7 fit).
 */
export function windowDays(origin: Date, range: RemindersRange): Date[] {
  const start = addDays(topOf(origin, range), -WINDOW[range]);
  const length = range === 'month' ? 2 * WINDOW.month + 7 : 2 * WINDOW.week + 7;
  return Array.from({ length }, (_, i) => addDays(start, i));
}

/** True when `top` is near or past the edge of the window around `origin`: re-centre on it. */
export const nearEdge = (top: Date, origin: Date, range: RemindersRange) =>
  Math.abs(daysBetween(topOf(origin, range), topOf(top, range))) > WINDOW[range] - EDGE[range];

/** The month a Monday-first week belongs to: the month of its Thursday (ISO 8601). */
export function focusMonth(date: Date): Date {
  const thursday = addDays(startOfWeek(date), 3);
  return new Date(thursday.getFullYear(), thursday.getMonth(), 1);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A cached `Intl.DateTimeFormat`. `toLocaleDateString` builds a new formatter
 * on every call, about 50 times the cost of reusing one, and a calendar
 * formats hundreds of labels per render.
 */
export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (!format) formatters.set(key, (format = new Intl.DateTimeFormat(locale, options)));
  return format;
}

/** "October 2026" (Month: the top week's month) or "8 – 14 October 2026" (Week: 7 days from the anchor). */
export function rangeLabel(anchor: Date, range: RemindersRange, locale: string): string {
  if (range === 'month') {
    return dateFormat(locale, { month: 'long', year: 'numeric' }).format(focusMonth(anchor));
  }
  return dateFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).formatRange(
    anchor,
    addDays(anchor, 6),
  );
}

/** "14:00": the calendar is a 24-hour grid, so its times are 24-hour in every locale. */
export const clockTime = (at: number | Date, locale: string) =>
  dateFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

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

export type ChipLayout = {
  fire: ReminderFire;
  top: number;
  lane: number;
  lanes: number;
  span: number;
};

/**
 * Side-by-side lanes for chips that would overlap in one day column. A chip
 * covers `span` minutes from its fire; chips that overlap, directly or through
 * a chain, share a cluster and split its width evenly. A chip alone in its
 * lane with `tall` free minutes below it is drawn `tall` (two lines).
 */
export function layoutChips(
  fires: readonly ReminderFire[],
  span: number,
  tall = span,
): ChipLayout[] {
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
    const chip = { fire, top, lane, lanes: 1, span };
    cluster.push(chip);
    out.push(chip);
  }
  close();
  out.forEach((chip, i) => {
    const next = out[i + 1];
    const room = !next || next.top - chip.top >= tall;
    if (chip.lanes === 1 && room && chip.top + tall <= DAY_MINUTES) chip.span = tall;
  });
  return out;
}

/** A frequent reminder's day: its first upcoming (else first) fire, and how many. */
export type DayGroup = { reminder: ProjectReminder; fire: ReminderFire; count: number };

export type CalendarDay = {
  date: Date;
  /** One chip per fire: every fire of a reminder that is not frequent. */
  chips: ReminderFire[];
  /** Frequent reminders with a fire this day, one entry each: counted, never chipped. */
  groups: DayGroup[];
  /** Every fire this day, frequent reminders included. */
  total: number;
};

export type CalendarModel = {
  days: CalendarDay[];
  /** Frequent reminders with a fire on screen, and their first upcoming (else first) fire. */
  frequent: { reminder: ProjectReminder; fire: ReminderFire }[];
  total: number;
  /** The clock the days were built with. */
  now: number;
};

function buildDay(
  date: Date,
  rare: readonly ProjectReminder[],
  often: readonly ProjectReminder[],
  now: number,
): CalendarDay {
  const from = date.getTime();
  const to = addDays(date, 1).getTime();
  const chips = expandFires(rare, from, to, now);
  const groups: DayGroup[] = [];
  let total = chips.length;
  for (const reminder of often) {
    const { count, fire } = fireStats(reminder, from, to, now);
    if (!fire) continue;
    groups.push({ reminder, fire, count });
    total += count;
  }
  return { date, chips, groups, total };
}

/**
 * Fires per day for the days on screen. Expanded one day at a time:
 * `expandFires` caps each reminder at 2000 fires per call, and a 5-minute
 * reminder makes 288 a day. Frequent reminders are counted, never expanded.
 *
 * `previous` is the last model for the same reminders. A day that was wholly
 * past at its clock, or is wholly future at this one, cannot have changed, so
 * its object is reused: the memoized rows and columns skip the clock tick.
 */
export function calendarModel(
  reminders: readonly ProjectReminder[],
  days: readonly Date[],
  now: number,
  previous?: CalendarModel,
): CalendarModel {
  const rare = reminders.filter((reminder) => !isFrequent(reminder));
  const often = reminders.filter(isFrequent);
  const reusable = new Map<number, CalendarDay>();
  if (previous && previous.now <= now) {
    for (const day of previous.days) {
      const end = addDays(day.date, 1).getTime();
      if (end <= previous.now || day.date.getTime() > now) reusable.set(day.date.getTime(), day);
    }
  }
  const frequent = new Map<string, { reminder: ProjectReminder; fire: ReminderFire }>();
  let total = 0;
  const out = days.map((date) => {
    const day = reusable.get(date.getTime()) ?? buildDay(date, rare, often, now);
    for (const { reminder, fire } of day.groups) {
      const seen = frequent.get(reminder.id);
      if (!seen || (seen.fire.past && !fire.past)) frequent.set(reminder.id, { reminder, fire });
    }
    total += day.total;
    return day;
  });
  return { days: out, frequent: [...frequent.values()], total, now };
}

/** A Month cell line: one fire, or a frequent reminder's day as one line with its count. */
export type MonthEntry = { fire: ReminderFire; count: number | null };

/** A day's Month lines by time: every fire of a non-frequent reminder, one line per frequent one. */
export function monthEntries(day: CalendarDay): MonthEntry[] {
  const out: MonthEntry[] = day.chips.map((fire) => ({ fire, count: null }));
  for (const group of day.groups) out.push({ fire: group.fire, count: group.count });
  return out.sort((a, b) => a.fire.at - b.fire.at);
}
