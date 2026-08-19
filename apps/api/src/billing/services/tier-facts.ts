/**
 * The config-free half of the tier vocabulary.
 *
 * `tiers.ts` reaches for `../../config` at module scope (Stripe price catalogs
 * are per-environment), which means importing ANY symbol from it boots env
 * validation. These few facts are pure data/predicates with no environment
 * dependency, so they live here and `tiers.ts` re-exports them — one definition,
 * importable from a genuinely pure module (`billing-state.ts`) without dragging
 * in configuration.
 */

/** Minimum wallet balance, in dollars, required to admit one run. */
export const MINIMUM_CREDIT_FOR_RUN = 0.01;

/** Returns true if the tier is a paid tier (not free/none). */
export function isPaidTier(tierName: string): boolean {
  return tierName !== 'free' && tierName !== 'none';
}

/**
 * Per-seat code paths must no-op for legacy customers. Use this guard at every
 * branch that would otherwise mutate Stripe quantity / grant seat credits /
 * meter compute / mint per-member YOLO tokens.
 */
export function isPerSeatAccount(billingModel: string | null | undefined): boolean {
  return billingModel === 'per_seat';
}

export function isLegacyAccount(billingModel: string | null | undefined): boolean {
  // Default for null/undefined is legacy — safer to skip new behaviour than to
  // accidentally bill a legacy customer twice.
  return billingModel !== 'per_seat' && billingModel !== 'credit';
}

/**
 * Billing v3 — flat credit plans (Starter / Team / Scale).
 *
 * The plan, not the headcount, carries the monthly credit pool and the
 * concurrency limit. Seats are gone: `seat_count` is meaningless here, nothing
 * mutates a Stripe quantity, and the grant comes from `TierConfig.monthlyCredits`
 * rather than `grantForSeats()`.
 */
export function isCreditPlanAccount(billingModel: string | null | undefined): boolean {
  return billingModel === 'credit';
}

/**
 * Does this account pay for sandbox compute?
 *
 * SEPARATE from `isPerSeatAccount` on purpose, and the distinction is load-
 * bearing. Compute metering was gated on "is this per-seat" because per-seat was
 * the only model that had ever metered. Read literally, that gate hands every
 * non-per-seat account free unmetered compute — which is precisely what a new
 * `credit` plan would have received, a revenue hole running straight through the
 * plans we are introducing.
 *
 * The question the meter actually wants to ask is this one. Use
 * `isPerSeatAccount` only for things that are genuinely about SEATS (Stripe
 * quantity reconciliation, seat-count credit grants, per-member YOLO tokens).
 */
export function accountMetersCompute(billingModel: string | null | undefined): boolean {
  return isPerSeatAccount(billingModel) || isCreditPlanAccount(billingModel);
}
