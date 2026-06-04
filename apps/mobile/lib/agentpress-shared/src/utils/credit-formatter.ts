export const CREDITS_PER_DOLLAR = 100;

export function dollarsToCredits(dollars: number): number {
  return Math.round(dollars * CREDITS_PER_DOLLAR);
}

export function creditsToDollars(credits: number): number {
  return credits / CREDITS_PER_DOLLAR;
}

export function formatCredits(
  credits: number | null | undefined,
  options?: { showDecimals?: boolean }
): string {
  if (credits === null || credits === undefined) return '0';
  const val = options?.showDecimals ? credits.toFixed(2) : Math.round(credits).toString();
  return val;
}

export function formatCreditsWithSign(
  credits: number | null | undefined,
  options?: { showDecimals?: boolean }
): string {
  if (credits === null || credits === undefined) return '0';
  const sign = credits >= 0 ? '+' : '';
  return `${sign}${formatCredits(credits, options)}`;
}

export function formatDollarsAsCredits(dollars: number): string {
  return formatCredits(dollarsToCredits(dollars));
}
