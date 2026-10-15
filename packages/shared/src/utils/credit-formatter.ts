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

export function creditsToDollars(credits: number): number {
  return credits / CREDITS_PER_DOLLAR;
}

export function formatDollarsAsCredits(
  dollars: number,
  options?: { showDecimals?: boolean },
): string {
  return formatCredits(dollarsToCredits(dollars), options);
}

/**
 * A USD amount the account HOLDS or SPENT (balance, usage, a turn's cost),
 * shown in credits (1 credit = $0.01). Prices the customer pays stay in USD.
 *
 * Whole credits from 10 up; below that up to two decimals, so a sub-cent turn
 * never reads 0; a non-zero amount under 0.01 credits reads `<0.01`.
 */
export function formatUsdAsCredits(
  usd: number | null | undefined,
  options?: { locale?: string },
): string {
  if (usd === null || usd === undefined || isNaN(usd)) return "0";
  const credits = usd * CREDITS_PER_DOLLAR;
  const magnitude = Math.abs(credits);
  const locale = options?.locale ?? "en-US";
  if (magnitude === 0) return "0";
  if (magnitude < 0.01) return `${credits < 0 ? "-" : ""}<${(0.01).toLocaleString(locale)}`;
  if (magnitude < 10) {
    return credits.toLocaleString(locale, { maximumFractionDigits: 2 });
  }
  return (Math.round(credits) + 0).toLocaleString(locale);
}

/**
 * Format credits for display with thousand separators
 * @param credits - The credit amount to format
 * @param options - Formatting options
 * @returns Formatted credit string with thousand separators (commas)
 */
export function formatCredits(
  credits: number | null | undefined,
  options?: { showDecimals?: boolean; locale?: string },
): string {
  // Handle null/undefined values
  if (credits === null || credits === undefined || isNaN(credits)) {
    return "0";
  }

  // `+ 0` normalizes negative zero (e.g. Math.round(-0.4) === -0) so it never
  // renders as the string "-0".
  const rounded = Math.round(credits) + 0;

  if (options?.showDecimals) {
    // Format with decimals and thousand separators
    return credits.toLocaleString(options.locale ?? "en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // Format as integer with thousand separators
  return rounded.toLocaleString(options?.locale ?? "en-US");
}

/**
 * Format credits with sign (+/-) prefix
 * @param credits - The credit amount to format
 * @param options - Formatting options
 * @returns Formatted credit string with sign prefix and thousand separators
 */
export function formatCreditsWithSign(
  credits: number | null | undefined,
  options?: { showDecimals?: boolean; locale?: string },
): string {
  // Handle null/undefined values
  if (credits === null || credits === undefined || isNaN(credits)) {
    return "0";
  }

  const formatted = formatCredits(Math.abs(credits), options);
  // Base the sign on the displayed magnitude: a tiny negative that rounds to 0
  // (e.g. -0.4) should read "+0", never "-0".
  const isNegative =
    credits < 0 && parseFloat(formatted.replace(/,/g, "")) !== 0;
  return isNegative ? `-${formatted}` : `+${formatted}`;
}
