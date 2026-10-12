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
/**
 * The fire to show when the calendar's range has none: the soonest upcoming
 * one, else the latest that happened, else a paused reminder's next slot.
 * Null when no reminder has a time at all.
 */
export function nearestFire(
  reminders: readonly Pick<SessionReminder, 'state' | 'next_fire_at' | 'last_fired_at' | 'at'>[],
): number | null {
  const soonest = soonestFire(reminders);
  if (soonest !== null) return soonest;
  let latest: number | null = null;
  let paused: number | null = null;
  for (const reminder of reminders) {
    const last = reminder.last_fired_at ? Date.parse(reminder.last_fired_at) : NaN;
    if (Number.isFinite(last) && (latest === null || last > latest)) latest = last;
    // A paused one-shot keeps its time in `at`; `next_fire_at` is cleared.
    const slot = reminder.next_fire_at ?? reminder.at;
    const next = slot ? Date.parse(slot) : NaN;
    if (reminder.state === 'paused' && Number.isFinite(next) && (paused === null || next < paused))
      paused = next;
  }
  return latest ?? paused;
}

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

/** "Cron 0 9 * * * Europe/Berlin", "Every 1h" or "Once"; `t` is the `reminders` translator. */
export function scheduleLabel(
  reminder: Pick<SessionReminder, 'cron' | 'timezone' | 'every'>,
  t: (key: 'cron' | 'every' | 'once', values?: Record<string, string>) => string,
): string {
  if (reminder.cron)
    return t('cron', { expression: [reminder.cron, reminder.timezone ?? ''].join(' ').trim() });
  return reminder.every ? t('every', { period: reminder.every }) : t('once');
}
