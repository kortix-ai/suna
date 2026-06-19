const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type RelativeTimeInput = number | Date | string | null | undefined;

export interface FormatRelativeOptions {
  /** Returned for null, undefined, or unparseable input. Default: null */
  empty?: string | null;
  /** Format future times as "in 5m" etc. Default: false */
  future?: boolean;
  /** Relative units after days: `full` adds weeks; `long` skips weeks and uses months/years */
  extended?: false | 'full' | 'long';
  /** Show second granularity. `true` = always; `'brief'` = only under 60s, with just-now under 5s */
  seconds?: boolean | 'brief';
  /** Days before switching to long units or date fallback. `null` = never fall back. Default: 30 */
  maxRelativeDays?: number | null;
  /** Date fallback style after relative thresholds. Default: short locale date */
  dateFallback?: Intl.DateTimeFormatOptions | 'iso' | false;
  /** Round unit counts instead of flooring. Default: false */
  round?: boolean;
  /** Label for sub-minute future times. Default: 'in-<1m' */
  futureSoon?: 'in-<1m' | 'in-a-moment';
  /** Label for sub-minute past times when `future` is true. Default: 'just-now' */
  pastSoon?: 'just-now' | '<1m-ago';
}

function toTimestamp(input: RelativeTimeInput): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (input instanceof Date) {
    const time = input.getTime();
    return Number.isNaN(time) ? null : time;
  }
  const time = new Date(input).getTime();
  return Number.isNaN(time) ? null : time;
}

function formatDateFallback(timestamp: number, dateFallback: FormatRelativeOptions['dateFallback']): string {
  if (dateFallback === false) {
    const days = Math.floor((Date.now() - timestamp) / DAY_MS);
    return `${days}d ago`;
  }
  if (dateFallback === 'iso') {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
  return new Date(timestamp).toLocaleDateString(undefined, dateFallback ?? { month: 'short', day: 'numeric' });
}

function unitValue(absDiff: number, unitMs: number, round: boolean): number {
  return round ? Math.round(absDiff / unitMs) : Math.floor(absDiff / unitMs);
}

function formatFuture(absDiff: number, round: boolean, futureSoon: NonNullable<FormatRelativeOptions['futureSoon']>): string {
  if (absDiff < MINUTE_MS) {
    return futureSoon === 'in-a-moment' ? 'in a moment' : 'in <1m';
  }
  if (absDiff < HOUR_MS) {
    return `in ${unitValue(absDiff, MINUTE_MS, round)}m`;
  }
  if (absDiff < DAY_MS) {
    return `in ${unitValue(absDiff, HOUR_MS, round)}h`;
  }
  return `in ${unitValue(absDiff, DAY_MS, round)}d`;
}

function formatLongUnits(days: number): string {
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function formatPast(
  absDiff: number,
  timestamp: number,
  options: Required<Pick<FormatRelativeOptions, 'extended' | 'seconds' | 'maxRelativeDays' | 'dateFallback' | 'round' | 'future' | 'pastSoon'>>,
): string {
  const { extended, seconds, maxRelativeDays, dateFallback, round, future, pastSoon } = options;

  if (future && absDiff < MINUTE_MS) {
    return pastSoon === '<1m-ago' ? '<1m ago' : 'just now';
  }

  if (seconds) {
    const sec = unitValue(absDiff, 1000, round);
    if (seconds === 'brief') {
      if (sec < 5) return 'just now';
      if (sec < 60) return `${sec}s ago`;
    } else if (sec < 60) {
      return sec < 1 ? 'just now' : `${sec}s ago`;
    }
  } else if (absDiff < MINUTE_MS) {
    return 'just now';
  }

  if (absDiff < HOUR_MS) {
    const minutes = unitValue(absDiff, MINUTE_MS, round);
    return minutes < 1 ? 'just now' : `${minutes}m ago`;
  }

  if (absDiff < DAY_MS) {
    return `${unitValue(absDiff, HOUR_MS, round)}h ago`;
  }

  const days = unitValue(absDiff, DAY_MS, round);

  if (maxRelativeDays != null && days >= maxRelativeDays) {
    if (extended === 'long' || extended === 'full') {
      return formatLongUnits(days);
    }
    return formatDateFallback(timestamp, dateFallback);
  }

  if (extended === 'full') {
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return formatDateFallback(timestamp, dateFallback);
  }

  if (extended === 'long' && days >= 7) {
    return formatLongUnits(days);
  }

  return `${days}d ago`;
}

/**
 * Format a timestamp into a human-readable relative time string (e.g. "5m ago").
 */
export function formatRelative(
  input: RelativeTimeInput,
  options: FormatRelativeOptions = {},
): string | null {
  const {
    empty = null,
    future = false,
    extended = false,
    seconds = false,
    maxRelativeDays = 30,
    dateFallback = { month: 'short', day: 'numeric' },
    round = false,
    futureSoon = 'in-<1m',
    pastSoon = 'just-now',
  } = options;

  const timestamp = toTimestamp(input);
  if (timestamp === null) return empty ?? null;

  const diffMs = Date.now() - timestamp;
  const absDiff = Math.abs(diffMs);
  const isFuture = diffMs < 0;

  if (isFuture) {
    if (!future) return 'just now';
    return formatFuture(absDiff, round, futureSoon);
  }

  return formatPast(absDiff, timestamp, {
    extended,
    seconds,
    maxRelativeDays,
    dateFallback,
    round,
    future,
    pastSoon,
  });
}

/** @alias formatRelative */
export const formatRelativeTime = formatRelative;

/** @alias formatRelative */
export const formatRelativeDate = formatRelative;
