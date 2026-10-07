import type { ProjectReminder, SessionReminderState } from '@kortix/sdk';
import { expandFires } from './reminder-schedule';

/** The rail's heatmap: 6 week columns of 7 weekday rows, from this week's Monday. */
export const RAIL_WEEKS = 6;
export const RAIL_DAYS = RAIL_WEEKS * 7;
/** "Most frequent" ranks reminders by their fires in this window. */
const FREQUENT_WINDOW_MS = 14 * 86_400_000;

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** Ascending by a time; a missing time sorts last. */
const byTime =
  (pick: (reminder: ProjectReminder) => string | null | undefined, direction: 1 | -1) =>
  (a: ProjectReminder, b: ProjectReminder) => {
    const left = time(pick(a));
    const right = time(pick(b));
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return (left - right) * direction;
  };

/**
 * One tab's rows, in reading order: active by the next fire (soonest first),
 * done by the last fire (latest first), paused by creation (newest first —
 * there is no paused-at timestamp).
 */
export function rowsForTab(
  reminders: readonly ProjectReminder[],
  tab: SessionReminderState,
): ProjectReminder[] {
  const rows = reminders.filter((reminder) => reminder.state === tab);
  if (tab === 'active') return rows.sort(byTime((r) => r.next_fire_at, 1));
  if (tab === 'done') return rows.sort(byTime((r) => r.last_fired_at, -1));
  return rows.sort(byTime((r) => r.created_at, -1));
}

export type RailModel = {
  /** Local midnight of this week's Monday: day 0 of the grid. */
  start: number;
  /** Upcoming fires per day, RAIL_DAYS long. Days before today are 0. */
  counts: number[];
  /** Index of today in `counts`. */
  today: number;
  total: number;
  /** Top 3 reminders by upcoming fires in the next 14 days. */
  frequent: { reminder: ProjectReminder; count: number }[];
  /** A cron reminder is in scope: it is left out of every count above. */
  hasCron: boolean;
};

const dayEdge = (start: Date, offset: number) =>
  new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset).getTime();

/**
 * The scheduled (upcoming) fires for the rail. Never history: there is no
 * fire-history API. Expanded one day at a time because `expandFires` caps
 * each reminder at 2000 fires per call, and the 5-minute floor makes 288 a day.
 * Cron reminders are left out: without a cron parser only their next fire is
 * known, and one fire would read as a complete count.
 */
export function railModel(all: readonly ProjectReminder[], now: number): RailModel {
  const reminders = all.filter((reminder) => !reminder.cron);
  const today = new Date(now);
  const todayIndex = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - todayIndex);
  const counts: number[] = [];
  const perReminder = new Map<string, { reminder: ProjectReminder; count: number }>();
  let total = 0;
  for (let day = 0; day < RAIL_DAYS; day++) {
    const from = Math.max(now, dayEdge(monday, day));
    const to = dayEdge(monday, day + 1);
    const fires = from < to ? expandFires(reminders, from, to, now).filter((f) => !f.past) : [];
    counts.push(fires.length);
    total += fires.length;
    for (const fire of fires) {
      if (fire.at >= now + FREQUENT_WINDOW_MS) continue;
      const entry = perReminder.get(fire.reminder.id) ?? { reminder: fire.reminder, count: 0 };
      entry.count++;
      perReminder.set(fire.reminder.id, entry);
    }
  }
  const frequent = [...perReminder.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  return {
    start: monday.getTime(),
    counts,
    today: todayIndex,
    total,
    frequent,
    hasCron: reminders.length < all.length,
  };
}

/** Heatmap intensity 0-4: 0 is no fire, 4 is the busiest day in the grid. */
export function heatLevel(count: number, max: number): number {
  return count <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
}
