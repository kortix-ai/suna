/**
 * Short "how long ago" label — `just now`, `12m ago`, `3h ago`, `11d ago`, then
 * an absolute date past a month. A future timestamp (a key expiry, a scheduled
 * run) counts down the same ladder: `in 5m`, `in 23h`, `in 1d`, then the date.
 *
 * Age is not decoration on a status: an error with no timestamp reads as "now",
 * which is how an 11-day-old build failure passed for a live one. Anything that
 * shows a past event shows its age — and an expiry that has not happened yet
 * must not read as if it already had.
 */
export function relativeTime(
  t?: string | number | null,
  locale = 'en',
  now: number = Date.now(),
): string {
  if (!t) return '';
  const then = typeof t === 'string' ? +new Date(t) : t;
  if (!Number.isFinite(then)) return '';
  const m = ((now - then) / 60000) | 0;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  if (m === 0) {
    // Within a minute of `now`. A fresh past stamp reads "just now"; an
    // imminent expiry still counts down — "in 1m" — because a key that stops
    // working in thirty seconds is not "just now" anything.
    if (then > now) {
      const countdown = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
      return countdown.format(1, 'minute');
    }
    return locale.toLowerCase().startsWith('en') ? 'just now' : formatter.format(0, 'second');
  }
  // `numeric: 'auto'` for the past ("yesterday", "5m ago"); `always` for the
  // future so a one-day-out expiry reads "in 1d", not Intl's "tomorrow" —
  // an expiry is a countdown the same way an age is an age.
  const rtf =
    m < 0
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' })
      : formatter;
  if (Math.abs(m) < 60) return rtf.format(-m, 'minute');
  const h = (m / 60) | 0;
  if (Math.abs(h) < 24) return rtf.format(-h, 'hour');
  const d = (h / 24) | 0;
  if (d > -30 && d < 30) return rtf.format(-d, 'day');
  return new Date(then).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
