import type { ProjectReminder } from '@kortix/sdk';

/**
 * One scheduled or inferred fire of a reminder. `at` is ms since epoch.
 * `confirmed` is true only for the reminder's real last_fired_at; every other
 * past fire is estimated from the schedule.
 */
export type ReminderFire = {
  reminder: ProjectReminder;
  at: number;
  past: boolean;
  confirmed: boolean;
};

const MAX_FIRES_PER_REMINDER = 2000;

/** Loop iterations of the last `expandFires` call, so tests can bound the work. */
export let expandSteps = 0;

/**
 * Walks one reminder's fires in [from, to), each once, calling `emit(at,
 * confirmed)` until it returns true (full). There is no fire-history API, so
 * past fires are inferred: an interval reminder fires at next_fire_at ± k *
 * every_seconds, and last_fired_at is a known past fire. Cron reminders show
 * only next_fire_at: the client has no cron parser. A paused one-shot shows
 * at its scheduled `at`.
 */
function walkFires(
  reminder: ProjectReminder,
  from: number,
  to: number,
  now: number,
  emit: (at: number, confirmed: boolean) => boolean,
): void {
  const visit = (at: number, confirmed = false) =>
    at >= from && at < to ? emit(at, confirmed) : false;
  const next = reminder.next_fire_at ? Date.parse(reminder.next_fire_at) : NaN;
  const last = reminder.last_fired_at ? Date.parse(reminder.last_fired_at) : NaN;
  const nextShown = reminder.state === 'active' && Number.isFinite(next);
  const step = (reminder.every_seconds ?? 0) * 1000;
  if (nextShown && step > 0) {
    // The API stamps last_fired_at when the fire completes, seconds after
    // the grid slot it fired for. The slot nearest last_fired_at (always
    // within step/2) is that same fire: skip it and emit the real time.
    // Forward slots are at or after next, backward ones before it, so no
    // slot repeats, and the skipped slot is the only one last_fired_at can equal.
    const replaced = Number.isFinite(last) ? next - Math.round((next - last) / step) * step : NaN;
    // Forward from the first step at or after `from`.
    for (let t = next + Math.max(0, Math.ceil((from - next) / step)) * step; t < to; t += step) {
      expandSteps++;
      if (t !== replaced && visit(t)) return;
    }
    // Backward: inferred past fires, never before the reminder existed.
    // Start at the window's end (or now, if sooner), not at now: a window
    // weeks in the past must not walk every step from today back to it.
    const created = reminder.created_at ? Date.parse(reminder.created_at) : NaN;
    const lowest = Number.isFinite(created) ? Math.max(from, created) : from;
    const newest = Math.min(now, to);
    for (let k = Math.max(1, Math.ceil((next - newest) / step)); next - k * step >= lowest; k++) {
      expandSteps++;
      if (next - k * step !== replaced && visit(next - k * step)) return;
    }
  } else if (nextShown && visit(next)) {
    return;
  }
  // A paused one-shot has no next fire but keeps its scheduled time: it stays
  // on the calendar there, so a filter or a jump to it finds it.
  const scheduled = reminder.at ? Date.parse(reminder.at) : NaN;
  if (
    reminder.state === 'paused' &&
    step <= 0 &&
    Number.isFinite(scheduled) &&
    scheduled !== last
  ) {
    if (visit(scheduled)) return;
  }
  if (Number.isFinite(last) && !(nextShown && step <= 0 && last === next)) visit(last, true);
}

/**
 * Every fire of each reminder in [from, to), sorted by time, at most 2000
 * per reminder. Pure: `now` is a parameter so tests and renders agree.
 */
export function expandFires(
  reminders: readonly ProjectReminder[],
  from: number,
  to: number,
  now: number,
): ReminderFire[] {
  const fires: ReminderFire[] = [];
  expandSteps = 0;
  for (const reminder of reminders) {
    let count = 0;
    walkFires(reminder, from, to, now, (at, confirmed) => {
      fires.push({ reminder, at, past: at <= now, confirmed });
      return ++count >= MAX_FIRES_PER_REMINDER;
    });
  }
  return fires.sort((a, b) => a.at - b.at);
}

/**
 * How many fires one reminder has in [from, to), and its first upcoming
 * (else first) fire, without building every fire: a 5-minute reminder has
 * 288 a day, and Month only shows the count. The same fires `expandFires`
 * returns.
 */
export function fireStats(
  reminder: ProjectReminder,
  from: number,
  to: number,
  now: number,
): { count: number; fire: ReminderFire | null } {
  let count = 0;
  // The first fire, and the first after now: [at, confirmed], at Infinity when none.
  const first = [Infinity, false] as [number, boolean];
  const upcoming = [Infinity, false] as [number, boolean];
  walkFires(reminder, from, to, now, (at, confirmed) => {
    count++;
    if (at < first[0]) {
      first[0] = at;
      first[1] = confirmed;
    }
    if (at > now && at < upcoming[0]) {
      upcoming[0] = at;
      upcoming[1] = confirmed;
    }
    return count >= MAX_FIRES_PER_REMINDER;
  });
  const [at, confirmed] = upcoming[0] < Infinity ? upcoming : first;
  return { count, fire: count ? { reminder, at, past: at <= now, confirmed } : null };
}

/** Fires per day of an interval reminder; null for cron and one-shot. */
export function firesPerDay(reminder: Pick<ProjectReminder, 'every_seconds'>): number | null {
  const every = reminder.every_seconds;
  return every && every > 0 ? 86_400 / every : null;
}

/** More than 4 fires a day: shown as a lane or a count, not one chip per fire. */
export function isFrequent(reminder: Pick<ProjectReminder, 'every_seconds'>): boolean {
  return (firesPerDay(reminder) ?? 0) > 4;
}
