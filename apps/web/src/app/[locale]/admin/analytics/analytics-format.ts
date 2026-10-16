/**
 * Pure formatters for the admin analytics page.
 *
 * Kept out of `page.tsx` because a Next.js page module may only export the
 * default component plus the framework's own route exports — an extra named
 * export there fails the build's page-export check. Living here also makes them
 * unit-testable (`analytics-format.test.ts`).
 */

import { CREDITS_PER_DOLLAR, formatUsdAsCredits } from '@kortix/shared';

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
 * Spend (credit burn) in credits, from the USD the API sends (1 credit = $0.01).
 *
 * Burn is often fractions of a cent per day early on; `formatUsdAsCredits`
 * keeps up to two decimals below 10 credits and prints `<0.01` for a real but
 * tiny amount, so a non-zero burn never renders as `0`.
 */
export function formatCredits(usd: number, locale = 'en-US'): string {
  return formatUsdAsCredits(usd, { locale });
}

/**
 * Axis ticks in credits: coarser than tooltips, because the axis must not wrap.
 *
 * Whole credits from 10 up. Below 10 every tick keeps exactly two decimals so
 * the column is aligned and each label states its real value: rounding a small
 * tick set such as 0 / 0.45 / 0.90 / 1.35 / 1.80 to whole units turned it into
 * a non-uniform scale with labels off by up to 26%.
 */
export function formatAxisCredits(usd: number, locale = 'en-US'): string {
  const credits = usd * CREDITS_PER_DOLLAR;
  if (credits === 0) return '0';
  if (Math.abs(credits) >= 10) return Math.round(credits).toLocaleString(locale);
  return credits.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
