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
 * Days rendered either side of the origin: 12 weeks (Month), 28 days (Week)
 * or 14 days (Day).
 * Every rendered day costs mount time, so the window is a few screens each way
 * and moves with the scroll instead of covering a year.
 */
const WINDOW: Record<RemindersRange, number> = { month: 12 * 7, week: 28, day: 14 };
/** Once the scroll settles this close to an edge, in days, the window re-centres. */
const EDGE: Record<RemindersRange, number> = { month: 5 * 7, week: 12, day: 6 };

/** The row (Month: a week, from its Monday) or column (Week, Day: a day) at the top-left for `date`. */
export const topOf = (date: Date, range: RemindersRange) =>
  range === 'month' ? startOfWeek(date) : startOfDay(date);

/**
 * The scrollable window around `origin`: Monday-first weeks for Month
 * (25 rows), consecutive days for Week (63 columns, so the last 7 fit) and
 * Day (29 columns, one in view).
 */
export function windowDays(origin: Date, range: RemindersRange): Date[] {
  const start = addDays(topOf(origin, range), -WINDOW[range]);
  const length = 2 * WINDOW[range] + (range === 'day' ? 1 : 7);
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

/**
 * The day the previous (-1) or next (+1) arrow goes to from `top`: a day
 * (Day), 7 days (Week), or the next month's first week (Month). That week
 * holds the 4th, so its Thursday, and with it the title, is in that month.
 */
export function stepDate(top: Date, range: RemindersRange, direction: 1 | -1): Date {
  if (range === 'day') return addDays(top, direction);
  if (range === 'week') return addDays(top, 7 * direction);
  const month = focusMonth(top);
  return new Date(month.getFullYear(), month.getMonth() + direction, 4);
}

/** The days on screen for a top day: one (Day), seven from it (Week), or its whole month (Month). */
export function visibleSpan(top: Date, range: RemindersRange): { from: Date; to: Date } {
  if (range === 'month') {
    const month = focusMonth(top);
    return { from: month, to: new Date(month.getFullYear(), month.getMonth() + 1, 1) };
  }
  const from = startOfDay(top);
  return { from, to: addDays(from, range === 'day' ? 1 : 7) };
}

/**
 * The model day with fires closest to `span`, for a span with none. Ties go
 * to the later day: the next fire is the likelier thing to look for. Null
 * when the model has no fire at all.
 */
export function nearestFireDay(
  days: readonly CalendarDay[],
  span: { from: Date; to: Date },
): Date | null {
  let best: Date | null = null;
  let bestDistance = Infinity;
  for (const { date, total } of days) {
    if (total === 0) continue;
    const before = daysBetween(date, span.from);
    const distance = before > 0 ? before : Math.max(0, daysBetween(span.to, date) + 1);
    if (distance < bestDistance || (distance === bestDistance && best !== null && date > best)) {
      best = date;
      bestDistance = distance;
    }
  }
  return best;
}

/** A day's earliest fire, chips and frequent groups alike; null on a day with none. */
export function firstFireAt(day: CalendarDay): number | null {
  const times = [...day.chips.map((fire) => fire.at), ...day.groups.map((group) => group.fire.at)];
  return times.length > 0 ? Math.min(...times) : null;
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

/**
 * "October 2026" (Month: the top week's month), "8 – 14 October 2026" (Week:
 * 7 days from the anchor) or "Wednesday, 14 October 2026" (Day).
 */
export function rangeLabel(anchor: Date, range: RemindersRange, locale: string): string {
  if (range === 'day') {
    return dateFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(anchor);
  }
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

/** The minute of the day at `y` pixels down a 24-hour grid `height` tall, clamped to 00:00–23:59. */
export const minuteAt = (y: number, height: number) =>
  Math.min(DAY_MINUTES - 1, Math.max(0, Math.floor((y / height) * DAY_MINUTES)));

/** "15:37" for a minute of the day. */
export const minuteLabel = (minute: number, locale: string) =>
  clockTime(new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60), locale);

export const minutesOfDay = (at: number) => {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
};

/**
 * A day's fires by hour: 24 lists, each sorted by time. The Week grid draws
 * one hour cell per list, full column width. Fires placed at their exact
 * minute in side-by-side lanes became a staircase of clipped titles on a
 * busy afternoon.
 */
export function hourCells(fires: readonly ReminderFire[]): ReminderFire[][] {
  const cells: ReminderFire[][] = Array.from({ length: 24 }, () => []);
  for (const fire of fires) cells[new Date(fire.at).getHours()]!.push(fire);
  for (const cell of cells) cell.sort((a, b) => a.at - b.at);
  return cells;
}

/**
 * The lines a cell shows when it has room for `limit`: all of them, or
 * `limit - 1` and a count for the "+N" that takes the last line.
 */
export function fold<T>(items: readonly T[], limit: number): { shown: T[]; rest: number } {
  if (items.length <= limit) return { shown: [...items], rest: 0 };
  return { shown: items.slice(0, limit - 1), rest: items.length - limit + 1 };
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
  let total = 0;
  const out = days.map((date) => {
    const day = reusable.get(date.getTime()) ?? buildDay(date, rare, often, now);
    total += day.total;
    return day;
  });
  return { days: out, total, now };
}

/** A Month cell line: one fire, or a frequent reminder's day as one line with its count. */
export type MonthEntry = { fire: ReminderFire; count: number | null };

/** A day's Month lines by time: every fire of a non-frequent reminder, one line per frequent one. */
export function monthEntries(day: CalendarDay): MonthEntry[] {
  const out: MonthEntry[] = day.chips.map((fire) => ({ fire, count: null }));
  for (const group of day.groups) out.push({ fire: group.fire, count: group.count });
  return out.sort((a, b) => a.fire.at - b.fire.at);
}
