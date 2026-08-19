export const CREDITS_PER_USD = 100;
export const DEFAULT_COMPUTE_HOURLY_PRICE_USD = 0.201312;
export const TEAM_CREDITS_PER_SEAT = 2500;

/**
 * Dollar value of one seat's monthly grant — the API's
 * `INCLUDED_CREDITS_PER_SEAT_USD` (apps/api/src/billing/services/tiers.ts),
 * expressed here in the web app's credit terms.
 *
 * DERIVED, not typed in a second time. A hardcoded copy of this number in the
 * post-checkout success toast had drifted to $20 and was quoting customers a
 * grant $5/seat smaller than the one they had just paid for — the class of
 * "blatantly wrong info" the seat copy was already corrected for once.
 * Anything user-facing that states the grant reads it from here.
 */
export const SEAT_GRANT_USD = TEAM_CREDITS_PER_SEAT / CREDITS_PER_USD;

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

export function estimateTeamCompute(seatCount: number): {
  monthlyCredits: number;
  runtimeHours: number;
} {
  const normalizedSeatCount = Math.max(1, Math.floor(seatCount));
  const monthlyCredits = normalizedSeatCount * TEAM_CREDITS_PER_SEAT;

  return {
    monthlyCredits,
    runtimeHours: estimateDefaultCompute(monthlyCredits).runtimeHours,
  };
}
