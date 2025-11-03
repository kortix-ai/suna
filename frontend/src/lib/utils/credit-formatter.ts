export const CREDITS_PER_DOLLAR = 100;

export function dollarsToCredits(dollars: number): number {
  return Math.round(dollars * CREDITS_PER_DOLLAR);
}

export function creditsToDollars(credits: number): number {
  return credits / CREDITS_PER_DOLLAR;
}

export function formatCredits(credits: number, options?: { showDecimals?: boolean }): string {
  if (options?.showDecimals) {
    return credits.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return Math.round(credits).toLocaleString('en-US');
}

export function formatDollarsAsCredits(dollars: number): string {
  const credits = dollarsToCredits(dollars);
  return formatCredits(credits);
}
