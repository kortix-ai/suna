export const CREDITS_PER_DOLLAR = 100;

export function dollarsToCredits(dollars: number): number {
  return Math.round(dollars * CREDITS_PER_DOLLAR);
}

export function creditsToDollars(credits: number): number {
  return credits / CREDITS_PER_DOLLAR;
}

/**
 * Format credits for display (no commas, since credits = cents)
 * @param credits - The credit amount to format
 * @param options - Formatting options
 * @returns Formatted credit string without thousands separators
 */
export function formatCredits(credits: number, options?: { showDecimals?: boolean }): string {
  if (options?.showDecimals) {
    return credits.toFixed(2);
  }
  // Round to nearest integer and convert to string without commas
  return Math.round(credits).toString();
}

export function formatDollarsAsCredits(dollars: number): string {
  const credits = dollarsToCredits(dollars);
  return formatCredits(credits);
}
