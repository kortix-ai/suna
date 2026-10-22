/**
 * Time helpers of the Capture area. A timeline day is the viewer's LOCAL day:
 * the browser's time zone names it, and the API groups recorded days in the
 * same zone (`timeline.days({ tz })`), so the day picker and the track agree.
 */

/** The browser's IANA time zone, e.g. `Europe/Berlin`. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** `YYYY-MM-DD` of an instant in the local time zone. */
export function localDayOf(at: string | number | Date): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole hours and minutes of a duration in seconds (rounded to the minute). */
export function durationParts(seconds: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** The index of the last item at or before `at` (items sorted by `ts`), or -1. */
export function indexAtOrBefore<T extends { ts: string }>(items: readonly T[], at: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(items[mid]!.ts) <= at) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** `14:32`, `2:32 PM` in the given locale: the hour without a leading zero. */
export function clockTime(at: string | number, locale: string, withSeconds = false): string {
  return new Date(at).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

/** `Sat 3 Oct` in the given locale. */
export function shortDate(at: string | number, locale: string): string {
  return new Date(at).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
