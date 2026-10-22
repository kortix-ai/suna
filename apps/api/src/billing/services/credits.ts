import type { getCreditAccount } from '../repositories/credit-accounts';

// Credit movements live in billing/wallet. This module derives the bucket
// summary from a credit row. Whether an account may run is
// billing-state.ts's answer, not the wallet floor's.

export function getCreditSummary(account: Awaited<ReturnType<typeof getCreditAccount>>) {
  if (!account) {
    return { total: 0, daily: 0, monthly: 0, extra: 0 };
  }

  return {
    total: Number(account.balance) || 0,
    daily: Number(account.dailyCreditsBalance) || 0,
    monthly: Number(account.expiringCredits) || 0,
    extra: Number(account.nonExpiringCredits) || 0,
  };
}
