export function formatCredits(
  credits: number | null | undefined,
  options?: { showDecimals?: boolean }
): string {
  if (credits === null || credits === undefined) return '0';
  const val = options?.showDecimals ? credits.toFixed(2) : Math.round(credits).toString();
  return val;
}
