export const CREDITS_PER_USD = 100;
export const DEFAULT_COMPUTE_HOURLY_PRICE_USD = 0.201312;

/**
 * The credits plan: one paid plan, any whole monthly amount from `MIN` to
 * `MAX` dollars. 1 credit = $0.01, flat rate, no volume bonus. These bounds
 * mirror `MIN_MONTHLY_USD` / `MAX_MONTHLY_USD` in apps/api (`GET
 * /v1/billing/tier-configurations` also returns them as `min_monthly_usd` and
 * `max_monthly_usd`); `POST /v1/billing/plan` answers 400 outside them.
 */
export const CREDITS_PLAN_MIN_USD = 20;
export const CREDITS_PLAN_MAX_USD = 10_000;

/** The Free plan's monthly grant, in credits. */
export const FREE_MONTHLY_CREDITS = 200;

/**
 * Named amounts. Labels only: every amount is the same rate, so a preset is a
 * shortcut for a number, never a different product.
 */
export const CREDITS_PLAN_PRESETS = [
  { id: 'starter', monthlyUsd: 20 },
  { id: 'pro', monthlyUsd: 100 },
  { id: 'scale', monthlyUsd: 500 },
] as const;

export type CreditsPlanPresetId = (typeof CREDITS_PLAN_PRESETS)[number]['id'];

/** The preset an amount equals, or `null` for a custom amount. */
export function presetForMonthlyUsd(monthlyUsd: number | null): CreditsPlanPresetId | null {
  return CREDITS_PLAN_PRESETS.find((preset) => preset.monthlyUsd === monthlyUsd)?.id ?? null;
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

export function estimateDefaultCompute(credits: number): {
  creditValueUsd: number;
  runtimeHours: number;
} {
  const normalizedCredits = Math.max(0, credits);
  const creditValueUsd = normalizedCredits / CREDITS_PER_USD;

  return {
    creditValueUsd,
    runtimeHours: creditValueUsd / DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  };
}

/** Default-machine hours a monthly amount buys when used only for compute. */
export function estimatePlanCompute(monthlyUsd: number): {
  monthlyCredits: number;
  runtimeHours: number;
} {
  const monthlyCredits = monthlyCreditsForUsd(Math.max(0, monthlyUsd));
  return {
    monthlyCredits,
    runtimeHours: estimateDefaultCompute(monthlyCredits).runtimeHours,
  };
}

/**
 * Slider position (0..100) for an amount, and back. The range spans 500x, so
 * the scale is logarithmic: a linear rail would put $20..$100 in the first 1%.
 * `amountFromSlider` snaps to $5 below $100, $25 below $1,000 and $100 above,
 * so the rail lands on round numbers; the number field takes any whole dollar.
 */
export function sliderFromMonthlyUsd(monthlyUsd: number): number {
  const clamped = Math.min(CREDITS_PLAN_MAX_USD, Math.max(CREDITS_PLAN_MIN_USD, monthlyUsd));
  return (
    (100 * Math.log(clamped / CREDITS_PLAN_MIN_USD)) /
    Math.log(CREDITS_PLAN_MAX_USD / CREDITS_PLAN_MIN_USD)
  );
}

export function amountFromSlider(position: number): number {
  const raw =
    CREDITS_PLAN_MIN_USD *
    Math.pow(
      CREDITS_PLAN_MAX_USD / CREDITS_PLAN_MIN_USD,
      Math.min(100, Math.max(0, position)) / 100,
    );
  const step = raw < 100 ? 5 : raw < 1000 ? 25 : 100;
  const snapped = Math.round(raw / step) * step;
  return Math.min(CREDITS_PLAN_MAX_USD, Math.max(CREDITS_PLAN_MIN_USD, snapped));
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
