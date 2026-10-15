export const CREDITS_PER_USD = 100;

/**
 * Compute list rates: Platinum's, at 1× on every provider. Mirrors the rate
 * card in apps/api (`platform/providers/compute-rates.ts`), which bills per
 * second for the reserved spec.
 */
export const COMPUTE_RATES_USD = {
  vcpuHour: 0.0324,
  memoryGbHour: 0.0108,
  diskGbMonth: 0.0526,
} as const;

/** Hours in a billing month for the per-month disk rate (365 × 24 / 12). */
const HOURS_PER_MONTH = 730;

/** The default agent computer, as the plan pages name it. */
export const DEFAULT_COMPUTE_RESOURCES = { vcpu: 2, memoryGb: 4, diskGb: 20 } as const;

/** USD a running hour of the default agent computer costs. */
export const DEFAULT_COMPUTE_HOURLY_PRICE_USD =
  DEFAULT_COMPUTE_RESOURCES.vcpu * COMPUTE_RATES_USD.vcpuHour +
  DEFAULT_COMPUTE_RESOURCES.memoryGb * COMPUTE_RATES_USD.memoryGbHour +
  (DEFAULT_COMPUTE_RESOURCES.diskGb * COMPUTE_RATES_USD.diskGbMonth) / HOURS_PER_MONTH;

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

/** Credits the default agent computer uses per running hour. */
export const DEFAULT_COMPUTE_CREDITS_PER_HOUR = Math.round(
  DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD,
);

/** The default agent computer, as the plan pages name it. */
export const DEFAULT_COMPUTE_SPEC = `${DEFAULT_COMPUTE_RESOURCES.vcpu} vCPU / ${DEFAULT_COMPUTE_RESOURCES.memoryGb} GB / ${DEFAULT_COMPUTE_RESOURCES.diskGb} GB`;

/** Minutes of default agent computer one credit buys (60 / credits per hour). */
export const MINUTES_PER_CREDIT = Math.round(60 / DEFAULT_COMPUTE_CREDITS_PER_HOUR);

/**
 * Kortix's platform fee on Kortix-model usage, in percent of the provider's
 * base price. Mirrors `platformFeePercent` from `GET /v1/projects/{id}/models`;
 * the app reads the served value, this constant is for pages with no API call.
 */
export const PLATFORM_FEE_PERCENT = 5.5;

/** Hours of default agent computer a credit amount buys, rounded to 10 from 100 up. */
export function agentHoursForCredits(credits: number): number {
  const hours = credits / (DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD);
  return hours >= 100 ? Math.round(hours / 10) * 10 : Math.round(hours);
}

/**
 * Top-up bonus ladder: a one-time or auto top-up adds a few percent of extra
 * credits, flat from $1,000. Mirrors `TOP_UP_BONUS_STEPS` in apps/api
 * (`billing/services/tiers.ts`), which grants it.
 */
export const TOP_UP_BONUS_STEPS = [
  { minUsd: 1_000, percent: 5 },
  { minUsd: 500, percent: 4 },
  { minUsd: 250, percent: 3 },
  { minUsd: 100, percent: 2 },
  { minUsd: 50, percent: 1 },
] as const;

/** Bonus credits a top-up of `amountUsd` adds. 0 below $50. */
export function topUpBonusCredits(amountUsd: number): number {
  const step = TOP_UP_BONUS_STEPS.find((s) => amountUsd >= s.minUsd);
  return step ? Math.round(amountUsd * step.percent) : 0;
}

/** `$100` — whole dollars, no decimals, in the reader's locale. */
export function formatWholeUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
