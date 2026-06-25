import { config } from '../../config';
import { getCreditAccount, upsertCreditAccount } from '../repositories/credit-accounts';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { grantCredits } from './credits';
import { MINIMUM_CREDIT_FOR_RUN } from './tiers';

export async function initializeFreeTierAccount(accountId: string): Promise<void> {
  const billingAnchor = new Date();
  await upsertCreditAccount(accountId, {
    tier: 'free',
    billingCycleAnchor: billingAnchor.toISOString(),
    nextCreditGrant: calculateNextCreditGrant(billingAnchor).toISOString(),
  });
  await grantCredits(
    accountId,
    5,
    'free_tier_grant',
    'Free tier welcome credits',
    true,
    `free_tier_signup:${accountId}`,
  );
}

/**
 * Idempotent signup repair: grant the free wallet before any billing gate runs.
 * Safe to call on every session create — only acts when the wallet is missing
 * or still on the legacy `none` tier with no balance.
 */
export async function ensureFreeTierAccountReady(accountId: string): Promise<void> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;

  const account = await getCreditAccount(accountId);
  if (!account) {
    await initializeFreeTierAccount(accountId);
    return;
  }

  const balance = Number(account.balance ?? 0);
  const tier = account.tier ?? 'none';
  const hasActiveSub =
    !!account.stripeSubscriptionId &&
    account.stripeSubscriptionStatus !== 'canceled' &&
    account.stripeSubscriptionStatus !== 'unpaid';

  if (hasActiveSub) return;

  if (tier === 'none' && balance < MINIMUM_CREDIT_FOR_RUN) {
    await initializeFreeTierAccount(accountId);
  }
}
