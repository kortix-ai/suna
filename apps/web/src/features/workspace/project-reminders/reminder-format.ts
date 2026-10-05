import type { SessionReminder } from '@kortix/sdk';

/**
 * A fire time as people read it: "in 12 min" / "in 3 hr" up to a day out,
 * then a short weekday-and-time ("Tue 09:00"), then a date. Past values say
 * how long ago. Pure: `now` is a parameter so tests and renders agree.
 */
export function formatFireTime(iso: string, locale: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const deltaMin = Math.round((at - now) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const abs = Math.abs(deltaMin);
  if (abs < 60) return rtf.format(deltaMin, 'minute');
  if (abs < 24 * 60) return rtf.format(Math.round(deltaMin / 60), 'hour');
  const date = new Date(at);
  if (deltaMin > 0 && deltaMin < 7 * 24 * 60) {
    return date.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The soonest scheduled fire among active reminders, in ms since epoch, or null. */
export function soonestFire(
  reminders: readonly Pick<SessionReminder, 'state' | 'next_fire_at'>[],
): number | null {
  let soonest: number | null = null;
  for (const reminder of reminders) {
    if (reminder.state !== 'active' || !reminder.next_fire_at) continue;
    const at = Date.parse(reminder.next_fire_at);
    if (Number.isFinite(at) && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

/** The first line of the reminder text, for a one-line row title. */
export function reminderTitle(reminder: Pick<SessionReminder, 'name' | 'prompt'>): string {
  return reminder.name ?? reminder.prompt.split('\n')[0]!.trim();
}
