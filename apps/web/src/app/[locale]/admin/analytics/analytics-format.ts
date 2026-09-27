/**
 * Pure formatters for the admin analytics page.
 *
 * Kept out of `page.tsx` because a Next.js page module may only export the
 * default component plus the framework's own route exports — an extra named
 * export there fails the build's page-export check. Living here also makes them
 * unit-testable (`analytics-format.test.ts`).
 */

/** `2026-08-07` -> `Aug 7`. Parsed as UTC so the label matches the API's bucket. */
export function formatDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * USD with enough precision to stay honest at both ends of the range.
 *
 * Burn is often fractions of a cent per day early on; rounding those to `$0.00`
 * would render a real number as nothing. Above $1 two decimals is plenty.
 */
export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${value.toFixed(4)}`;
}

/**
 * Axis ticks: coarser than tooltips, because the axis must not wrap.
 *
 * The cutover is at $10, not $1. Rounding to whole dollars from $1 up turned a
 * real recharts tick set of 0 / 0.45 / 0.90 / 1.35 / 1.80 into
 * `$0 · $0.45 · $0.90 · $1 · $2` — two ticks whose labels were off by up to 26%
 * and read as a broken, non-uniform scale. Below $10 every tick keeps exactly
 * two decimals so the column is aligned and each label states its real value.
 */
export function formatAxisUsd(value: number): string {
  if (value === 0) return '$0';
  if (value >= 10) return `$${Math.round(value).toLocaleString('en-US')}`;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Period-over-period change as a signed percentage string.
 *
 * Returns null when the previous period is zero or negative: "up ∞%" is not
 * information, and "+100%" for 0 -> 5 would be a lie about the baseline. The
 * caller shows the raw previous value instead.
 */
export function formatDelta(current: number, previous: number): string | null {
  if (previous <= 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.round(pct);
  if (rounded === 0) return 'flat vs prev 7d';
  return `${rounded > 0 ? '+' : ''}${rounded}% vs prev 7d`;
}

/** Growth direction for the sessions tile. Neutral when there is no baseline. */
export function deltaTone(current: number, previous: number): 'default' | 'success' | 'warning' {
  if (previous <= 0) return 'default';
  if (current > previous) return 'success';
  if (current < previous) return 'warning';
  return 'default';
}
