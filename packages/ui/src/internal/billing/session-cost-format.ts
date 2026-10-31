import { CREDITS_PER_DOLLAR, formatUsdAsCredits } from '@kortix/shared';

// A session's cost is an amount the account SPENT, so it reads in credits
// (1 credit = $0.01). The API sends USD; only the display converts.
//
// Whole credits from 10 up, up to two decimals below that, and `<0.01` for a
// non-zero amount under one hundredth of a credit, so a column stays short.
// The exact value stays reachable via formatSessionCostExactCredits
// (tooltips, the session ledger), so precision is relocated, not lost.
export function formatSessionCostCredits(value: number, locale?: string): string {
  return formatUsdAsCredits(Number.isFinite(value) ? value : 0, { locale });
}

export function formatSessionCostExactCredits(value: number, locale = 'en-US'): string {
  const credits = (Number.isFinite(value) ? value : 0) * CREDITS_PER_DOLLAR;
  return credits.toLocaleString(locale, {
    maximumFractionDigits: Math.abs(credits) < 10 ? 8 : 2,
  });
}

// The session usage view reads model spend in US dollars, the unit the ledger
// stores. Two decimals from $1 up, up to four below, and `<$0.0001` for a
// non-zero amount under that, so a cheap model's session never reads $0.00.
const SMALLEST_USD = 0.0001;

export function formatSessionCostUsd(value: number, locale = 'en-US'): string {
  const usd = Number.isFinite(value) ? value : 0;
  const format = (amount: number, maximumFractionDigits: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits }).format(amount);
  if (usd !== 0 && Math.abs(usd) < SMALLEST_USD) return `<${format(SMALLEST_USD, 4)}`;
  return format(usd, Math.abs(usd) < 1 ? 4 : 2);
}

export function formatSessionCostDuration(value: number): string {
  let remaining = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const units = [
    { label: 'd', seconds: 86_400 },
    { label: 'h', seconds: 3_600 },
    { label: 'm', seconds: 60 },
    { label: 's', seconds: 1 },
  ] as const;
  const parts: string[] = [];

  for (const unit of units) {
    const amount = Math.floor(remaining / unit.seconds);
    remaining %= unit.seconds;
    if (amount > 0 || (unit.label === 's' && parts.length === 0)) {
      parts.push(`${amount}${unit.label}`);
    }
    if (parts.length === 2) break;
  }

  return parts.join(' ');
}
