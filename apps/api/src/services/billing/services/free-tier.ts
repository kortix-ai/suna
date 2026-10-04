import { config } from '../../../lib/config';
import { getCreditAccount, upsertCreditAccount } from '../repositories/credit-accounts';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { wallet } from '../wallet';
import { MINIMUM_CREDIT_FOR_RUN } from './tiers';

export async function initializeFreeTierAccount(accountId: string): Promise<void> {
  const billingAnchor = new Date();
  await upsertCreditAccount(accountId, {
    tier: 'free',
    billingCycleAnchor: billingAnchor.toISOString(),
    nextCreditGrant: calculateNextCreditGrant(billingAnchor).toISOString(),
  });
  await wallet.grant({
    accountId,
    amount: 2,
    kind: 'free_tier_grant',
    description: 'Free tier welcome credits',
    expiring: true,
    key: { event: `free_tier_signup:${accountId}` },
  });
}

/**
 * Idempotent signup repair: grant the free wallet before any billing gate runs.
 * Safe to call on every session create — only acts when the wallet is missing
 * or still on the legacy `none` tier with no balance.
 *
 * STORED TIER ON PURPOSE — not the effective plan. This is a GRANT path, and it
 * repairs the row itself: the question is literally "does this row still say
 * `none` with an empty wallet", which only the stored column can answer. The
 * effective-plan resolver would report a trialing account as its trial plan and
 * skip the repair, leaving the row unprovisioned when the trial lapses.
 *
 * Returns the row it read when it changed nothing, so the gate that runs next
 * does not read the same row again. Null after a repair: read it fresh.
 */
export async function ensureFreeTierAccountReady(
  accountId: string,
): Promise<Awaited<ReturnType<typeof getCreditAccount>> | null> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return null;

  const account = await getCreditAccount(accountId);
  if (!account) {
    await initializeFreeTierAccount(accountId);
    return null;
  }

  const balance = Number(account.balance ?? 0);
  const tier = account.tier ?? 'none';
  const hasActiveSub =
    !!account.stripeSubscriptionId &&
    account.stripeSubscriptionStatus !== 'canceled' &&
    account.stripeSubscriptionStatus !== 'unpaid';

  if (hasActiveSub) return account;

  if (tier === 'none' && balance < MINIMUM_CREDIT_FOR_RUN) {
    await initializeFreeTierAccount(accountId);
    return null;
  }
  return account;
}
