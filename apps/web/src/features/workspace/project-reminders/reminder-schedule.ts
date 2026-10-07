import type { ProjectReminder } from '@kortix/sdk';

/**
 * One scheduled or inferred fire of a reminder. `at` is ms since epoch.
 * `confirmed` is true only for the reminder's real last_fired_at; every other
 * past fire is estimated from the schedule.
 */
export type ReminderFire = { reminder: ProjectReminder; at: number; past: boolean; confirmed: boolean };

const MAX_FIRES_PER_REMINDER = 2000;

/** Loop iterations of the last `expandFires` call, so tests can bound the work. */
export let expandSteps = 0;

/**
 * Every fire of each reminder in [from, to), sorted by time. There is no
 * fire-history API, so past fires are inferred: an interval reminder fires at
 * next_fire_at ± k * every_seconds, and last_fired_at is a known past fire.
 * Cron reminders show only next_fire_at: the client has no cron parser.
 * Pure: `now` is a parameter so tests and renders agree.
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
    const seen = new Set<number>();
    const emit = (at: number, confirmed = false) => {
      if (at < from || at >= to || seen.size >= MAX_FIRES_PER_REMINDER || seen.has(at)) return;
      seen.add(at);
      fires.push({ reminder, at, past: at <= now, confirmed });
    };

    const next = reminder.next_fire_at ? Date.parse(reminder.next_fire_at) : NaN;
    const last = reminder.last_fired_at ? Date.parse(reminder.last_fired_at) : NaN;
    if (reminder.state === 'active' && Number.isFinite(next)) {
      const step = (reminder.every_seconds ?? 0) * 1000;
      if (step > 0) {
        // The API stamps last_fired_at when the fire completes, seconds after
        // the grid slot it fired for. The slot nearest last_fired_at (always
        // within step/2) is that same fire: skip it and emit the real time.
        const replaced = Number.isFinite(last) ? next - Math.round((next - last) / step) * step : NaN;
        // Forward from the first step at or after `from`.
        for (let t = next + Math.max(0, Math.ceil((from - next) / step)) * step; t < to; t += step) {
          expandSteps++;
          if (seen.size >= MAX_FIRES_PER_REMINDER) break;
          if (t !== replaced) emit(t);
        }
        // Backward: inferred past fires, never before the reminder existed.
        // Start at the window's end (or now, if sooner), not at now: a window
        // weeks in the past must not walk every step from today back to it.
        const created = reminder.created_at ? Date.parse(reminder.created_at) : NaN;
        const lowest = Number.isFinite(created) ? Math.max(from, created) : from;
        const newest = Math.min(now, to);
        for (let k = Math.max(1, Math.ceil((next - newest) / step)); next - k * step >= lowest; k++) {
          expandSteps++;
          if (seen.size >= MAX_FIRES_PER_REMINDER) break;
          if (next - k * step !== replaced) emit(next - k * step);
        }
      } else {
        emit(next);
      }
    }

    if (Number.isFinite(last)) emit(last, true);
  }
  return fires.sort((a, b) => a.at - b.at);
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
