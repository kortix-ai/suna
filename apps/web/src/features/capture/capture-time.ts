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

/** `[from, to)` of a local day as ISO instants. Daylight-saving days are 23 or 25 hours. */
export function dayWindow(day: string): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return {
    from: new Date(y, m - 1, d).toISOString(),
    to: new Date(y, m - 1, d + 1).toISOString(),
  };
}

/** `[from, to)` of the last `days` local days, today included. */
export function lastDaysWindow(days: number, now = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Whole hours and minutes of a duration in seconds (rounded to the minute). */
export function durationParts(seconds: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** Clamp `at` into `[from, to]`. */
export function clampTime(at: number, from: number, to: number): number {
  return Math.min(Math.max(at, from), to);
}

/**
 * The visible span of a day's track: from the hour before the first recorded
 * moment to the hour after the last, so the runs fill the track instead of a
 * mostly empty 24 hours. An empty day shows 08:00 to 18:00.
 */
export function trackSpan(
  day: string,
  firstMs: number | null,
  lastMs: number | null,
): { start: number; end: number } {
  const { from, to } = dayWindow(day);
  const dayStart = Date.parse(from);
  const dayEnd = Date.parse(to);
  if (firstMs === null || lastMs === null) {
    return { start: dayStart + 8 * 3_600_000, end: dayStart + 18 * 3_600_000 };
  }
  const floorHour = (ms: number) => {
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  };
  const start = Math.max(dayStart, floorHour(firstMs));
  const end = Math.min(dayEnd, floorHour(lastMs) + 3_600_000);
  return { start, end: Math.max(end, start + 3_600_000) };
}

/** The whole hours inside a span, for the track's axis labels. */
export function hourTicks(start: number, end: number): number[] {
  const ticks: number[] = [];
  const d = new Date(start);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < start) d.setHours(d.getHours() + 1);
  while (d.getTime() <= end) {
    ticks.push(d.getTime());
    d.setHours(d.getHours() + 1);
  }
  return ticks;
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

/** The five chart tokens, assigned to apps by a stable hash of the name. */
const CHART_TOKENS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export function appColor(app: string | null | undefined): string {
  if (!app) return 'var(--muted-foreground)';
  let hash = 0;
  for (let i = 0; i < app.length; i++) hash = (hash * 31 + app.charCodeAt(i)) >>> 0;
  return CHART_TOKENS[hash % CHART_TOKENS.length]!;
}

/** "12 seconds ago", "3 hours ago" in the given locale. */
export function relativeTime(at: number, locale: string, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3_600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3_600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

/** `14:32` in the given locale. */
export function clockTime(at: string | number, locale: string, withSeconds = false): string {
  return new Date(at).toLocaleTimeString(locale, {
    hour: '2-digit',
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
