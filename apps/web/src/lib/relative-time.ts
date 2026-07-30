/**
 * Short "how long ago" label — `just now`, `12m ago`, `3h ago`, `11d ago`, then
 * an absolute date past a month.
 *
 * Age is not decoration on a status: an error with no timestamp reads as "now",
 * which is how an 11-day-old build failure passed for a live one. Anything that
 * shows a past event shows its age.
 */
export function relativeTime(t?: string | number | null): string {
  if (!t) return '';
  const then = typeof t === 'string' ? +new Date(t) : t;
  if (!Number.isFinite(then)) return '';
  const m = ((Date.now() - then) / 60000) | 0;
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = (m / 60) | 0;
  if (h < 24) return `${h}h ago`;
  const d = (h / 24) | 0;
  if (d < 30) return `${d}d ago`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
