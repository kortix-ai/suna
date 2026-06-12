/**
 * Credit Formatter Utility
 * 
 * Functions for formatting and converting credits
 * Robust version with null handling from mobile implementation
 */

export const CREDITS_PER_DOLLAR = 100;

/**
 * Convert dollars to credits
 * @param dollars - The dollar amount to convert
 * @returns The equivalent credit amount
 */
export function dollarsToCredits(dollars: number): number {
  return Math.round(dollars * CREDITS_PER_DOLLAR);
}

/**
 * Convert credits to dollars
 * @param credits - The credit amount to convert
 * @returns The equivalent dollar amount
 */
export function creditsToDollars(credits: number): number {
  return credits / CREDITS_PER_DOLLAR;
}

/**
 * Format credits for display with thousand separators
 * @param credits - The credit amount to format
 * @param options - Formatting options
 * @returns Formatted credit string with thousand separators (commas)
 */
export function formatCredits(credits: number | null | undefined, options?: { showDecimals?: boolean }): string {
  // Handle null/undefined values
  if (credits === null || credits === undefined || isNaN(credits)) {
    return '0';
  }
  
  // `+ 0` normalizes negative zero (e.g. Math.round(-0.4) === -0) so it never
  // renders as the string "-0".
  const rounded = Math.round(credits) + 0;
  
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
export function formatCreditsWithSign(credits: number | null | undefined, options?: { showDecimals?: boolean }): string {
  // Handle null/undefined values
  if (credits === null || credits === undefined || isNaN(credits)) {
    return '0';
  }
  
  const formatted = formatCredits(Math.abs(credits), options);
  // Base the sign on the displayed magnitude: a tiny negative that rounds to 0
  // (e.g. -0.4) should read "+0", never "-0".
  const isNegative = credits < 0 && parseFloat(formatted.replace(/,/g, '')) !== 0;
  return isNegative ? `-${formatted}` : `+${formatted}`;
}

/**
 * Format dollars as credits
 * @param dollars - The dollar amount to format as credits
 * @returns Formatted credit string
 */
export function formatDollarsAsCredits(dollars: number): string {
  const credits = dollarsToCredits(dollars);
  return formatCredits(credits);
}

