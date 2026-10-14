export const CREDITS_PER_USD = 100;
export const DEFAULT_COMPUTE_HOURLY_PRICE_USD = 0.201312;

/**
 * The credits plan: one paid plan, sold as a tier ladder of monthly amounts.
 * 1 credit = $0.01 at every tier, so a bigger tier buys more credits, never a
 * cheaper credit. The bounds mirror `PLAN_MIN_MONTHLY_USD` /
 * `PLAN_MAX_MONTHLY_USD` in apps/api (`GET /v1/billing/tier-configurations`
 * returns the same ladder); `POST /v1/billing/plan` answers 400 outside them.
 */
export const CREDITS_PLAN_MIN_USD = 50;
export const CREDITS_PLAN_MAX_USD = 10_000;

/** The Free plan's monthly grant, in credits. */
export const FREE_MONTHLY_CREDITS = 200;

export type CreditTierGroup = 'small' | 'growing' | 'scale';

export interface CreditTier {
  monthlyUsd: number;
  group: CreditTierGroup;
  /** The most common paid amount at or above the minimum. */
  popular?: boolean;
}

/** The tier ladder, smallest first. Mirrors `PLAN_PRESETS` in apps/api. */
export const CREDIT_TIERS: readonly CreditTier[] = [
  { monthlyUsd: 50, group: 'small' },
  { monthlyUsd: 100, group: 'small' },
  { monthlyUsd: 200, group: 'small', popular: true },
  { monthlyUsd: 300, group: 'growing' },
  { monthlyUsd: 500, group: 'growing' },
  { monthlyUsd: 750, group: 'growing' },
  { monthlyUsd: 1_000, group: 'growing' },
  { monthlyUsd: 1_500, group: 'growing' },
  { monthlyUsd: 2_000, group: 'growing' },
  { monthlyUsd: 3_000, group: 'scale' },
  { monthlyUsd: 5_000, group: 'scale' },
  { monthlyUsd: 7_500, group: 'scale' },
  { monthlyUsd: 10_000, group: 'scale' },
];

export const CREDIT_TIER_GROUPS: readonly CreditTierGroup[] = ['small', 'growing', 'scale'];

/** The tier a page opens on: the most popular one. */
export const DEFAULT_TIER_USD = CREDIT_TIERS.find((tier) => tier.popular)!.monthlyUsd;

/** The ladder tier for an amount, or `undefined` for an amount off the ladder (a legacy plan). */
export function tierForMonthlyUsd(monthlyUsd: number | null | undefined): CreditTier | undefined {
  return CREDIT_TIERS.find((tier) => tier.monthlyUsd === monthlyUsd);
}

/** Whether `monthlyUsd` is an amount the API accepts: a whole dollar in range. */
export function isValidMonthlyUsd(monthlyUsd: number | null | undefined): monthlyUsd is number {
  return (
    typeof monthlyUsd === 'number' &&
    Number.isInteger(monthlyUsd) &&
    monthlyUsd >= CREDITS_PLAN_MIN_USD &&
    monthlyUsd <= CREDITS_PLAN_MAX_USD
  );
}

/** Credits a monthly dollar amount buys. */
export function monthlyCreditsForUsd(monthlyUsd: number): number {
  return Math.round(monthlyUsd * CREDITS_PER_USD);
}

/**
 * Credits one agent session costs on Kortix Cloud: the median and the 75th
 * percentile over every session that spent credits in the 30 days to
 * 2026-10-14 (32,963 sessions, compute + managed models). Long runs sit near
 * the 90th percentile, 121 credits.
 */
export const SESSION_CREDITS_MEDIAN = 6;
export const SESSION_CREDITS_P75 = 24;
export const SESSION_CREDITS_P90 = 121;

/** How many typical agent sessions a monthly credit amount covers: [busy, light]. */
export function sessionsForCredits(credits: number): [number, number] {
  const round = (n: number) => (n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n / 10) * 10);
  return [round(credits / SESSION_CREDITS_P75), round(credits / SESSION_CREDITS_MEDIAN)];
}

/** Credits the default agent computer uses per running hour. */
export const DEFAULT_COMPUTE_CREDITS_PER_HOUR = Math.round(
  DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD,
);

/** `$100` — whole dollars, no decimals, in the reader's locale. */
export function formatWholeUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
