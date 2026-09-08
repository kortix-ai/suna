/**
 * Short "how long ago" label — `just now`, `12m ago`, `3h ago`, `11d ago`, then
 * an absolute date past a month.
 *
 * Age is not decoration on a status: an error with no timestamp reads as "now",
 * which is how an 11-day-old build failure passed for a live one. Anything that
 * shows a past event shows its age.
 */
export function relativeTime(t?: string | number | null, locale = 'en'): string {
  if (!t) return '';
  const then = typeof t === 'string' ? +new Date(t) : t;
  if (!Number.isFinite(then)) return '';
  const m = ((Date.now() - then) / 60000) | 0;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  if (m < 1)
    return locale.toLowerCase().startsWith('en') ? 'just now' : formatter.format(0, 'second');
  if (m < 60) return formatter.format(-m, 'minute');
  const h = (m / 60) | 0;
  if (h < 24) return formatter.format(-h, 'hour');
  const d = (h / 24) | 0;
  if (d < 30) return formatter.format(-d, 'day');
  return new Date(then).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
