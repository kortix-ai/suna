export const CREDITS_PER_USD = 100;
export const DEFAULT_COMPUTE_HOURLY_PRICE_USD = 0.201312;
export const TEAM_CREDITS_PER_SEAT = 2500;

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
