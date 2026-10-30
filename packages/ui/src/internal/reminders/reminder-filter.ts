import type { SessionReminder } from '@kortix/sdk';

export type ReminderStatusFilter = 'all' | 'active' | 'paused' | 'failed';
/** By next run: within the hour, the day, the week, or later than a week. */
export type ReminderTimeFilter = 'any' | 'hour' | 'day' | 'week' | 'later';

export const REMINDER_STATUS_FILTERS: readonly ReminderStatusFilter[] = ['all', 'active', 'paused', 'failed'];
export const REMINDER_TIME_FILTERS: readonly ReminderTimeFilter[] = ['any', 'hour', 'day', 'week', 'later'];

const HOUR = 60 * 60 * 1000;
const WINDOW_MS: Record<Exclude<ReminderTimeFilter, 'any' | 'later'>, number> = {
  hour: HOUR,
  day: 24 * HOUR,
  week: 7 * 24 * HOUR,
};

export function matchesStatus(reminder: SessionReminder, status: ReminderStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'failed') return reminder.last_status === 'failed';
  return status === 'active' ? reminder.state === 'active' : reminder.state !== 'active';
}

/** A time filter other than `any` keeps only active reminders: a paused one has no next run. */
export function matchesTime(reminder: SessionReminder, time: ReminderTimeFilter, now: number): boolean {
  if (time === 'any') return true;
  const next = reminder.state === 'active' && reminder.next_fire_at ? Date.parse(reminder.next_fire_at) : NaN;
  if (!Number.isFinite(next)) return false;
  if (time === 'later') return next - now > WINDOW_MS.week;
  return next - now <= WINDOW_MS[time];
}

/** Every word of the query appears in the title, the prompt or the schedule label. */
export function matchesQuery(reminder: SessionReminder, query: string, schedule: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [reminder.name, reminder.prompt, schedule].filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}
