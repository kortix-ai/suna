export const CREDITS_PER_DOLLAR = 100;

export function dollarsToCredits(dollars: number): number {
  return Math.round(dollars * CREDITS_PER_DOLLAR);
}

export function creditsToDollars(credits: number): number {
  return credits / CREDITS_PER_DOLLAR;
}

/**
 * Format credits for display with thousand separators
 * @param credits - The credit amount to format
 * @param options - Formatting options
 * @returns Formatted credit string with thousand separators (commas)
 */
export function formatCredits(credits: number, options?: { showDecimals?: boolean }): string {
  const rounded = Math.round(credits);
  
  if (options?.showDecimals) {
    // Format with decimals and thousand separators
    return credits.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  
  // Format as integer with thousand separators
  return rounded.toLocaleString('en-US');
}

/**
 * Format credits with sign (+/-) prefix
 * @param credits - The credit amount to format
 * @param options - Formatting options
 * @returns Formatted credit string with sign prefix and thousand separators
 */
export function formatCreditsWithSign(credits: number, options?: { showDecimals?: boolean }): string {
  const formatted = formatCredits(Math.abs(credits), options);
  return credits >= 0 ? `+${formatted}` : `-${formatted}`;
}

export function formatDollarsAsCredits(dollars: number): string {
  const credits = dollarsToCredits(dollars);
  return formatCredits(credits);
}
