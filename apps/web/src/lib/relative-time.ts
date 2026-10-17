/** The long-form options every build/audit "age" stamp shares. */
export const LONG_AGO = { style: 'long', empty: '—', zero: 'minute' } as const;

/**
 * Short "how long ago" label — `just now`, `12m ago`, `3h ago`, `11d ago`, then
 * an absolute date past a month.
 *
 * Age is not decoration on a status: an error with no timestamp reads as "now",
 * which is how an 11-day-old build failure passed for a live one. Anything that
 * shows a past event shows its age.
 */
export function relativeTime(
  t?: string | number | null,
  locale = 'en',
  now = Date.now(),
  options: {
    style?: Intl.RelativeTimeFormatStyle;
    empty?: string;
    zero?: 'second' | 'minute';
  } = {},
): string {
  if (!t) return options.empty ?? '';
  const then = typeof t === 'string' ? +new Date(t) : t;
  if (!Number.isFinite(then)) return options.empty ?? '';
  const m = Math.max(0, Math.trunc((now - then) / 60000));
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: options.style ?? 'narrow',
  });
  if (m < 1)
    return !options.zero && locale.toLowerCase().startsWith('en')
      ? 'just now'
      : formatter.format(0, options.zero ?? 'second');
  if (m < 60) return formatter.format(-m, 'minute');
  const h = (m / 60) | 0;
  if (h < 24) return formatter.format(-h, 'hour');
  const d = (h / 24) | 0;
  if (d < 30) return formatter.format(-d, 'day');
  return new Date(then).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
