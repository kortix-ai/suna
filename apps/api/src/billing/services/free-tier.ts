import { config } from '../../config';
import { getCreditAccount, upsertCreditAccount } from '../repositories/credit-accounts';
import { isWorkspaceSplitTarget } from '../repositories/split-targets';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { wallet } from '../wallet';
import { getTier, MINIMUM_CREDIT_FOR_RUN } from './tiers';

/**
 * Put an account on Free. With `freeCredits` (the default) it also grants the
 * free signup credits. `freeCredits: false` is a person's second or later
 * workspace (Workspaces, 2026-11-05: one free grant per person,
 * `free-credit-claims.ts`): Free with 0 credits, marked
 * `free_credits_eligible = false`, so neither the monthly rotation nor the
 * repair below ever grants it.
 */
export async function initializeFreeTierAccount(
  accountId: string,
  options: { freeCredits?: boolean } = {},
): Promise<void> {
  const freeCredits = options.freeCredits !== false;
  const billingAnchor = new Date();
  const expiresAt = calculateNextCreditGrant(billingAnchor).toISOString();
  // A workspace without free credits gets no grant date: no grant ever comes.
  await upsertCreditAccount(accountId, {
    tier: 'free',
    billingCycleAnchor: billingAnchor.toISOString(),
    ...(freeCredits ? { nextCreditGrant: expiresAt } : { nextCreditGrant: null, freeCreditsEligible: false }),
  });
  if (!freeCredits) return;
  await wallet.grant({
    accountId,
    amount: getTier('free').monthlyCredits,
    kind: 'free_tier_grant',
    description: 'Free tier welcome credits',
    expiring: true,
    expiresAt,
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
    // A split-off workspace whose row is missing gets Free with 0 credits:
    // its person holds the free grant in their first workspace.
    await initializeFreeTierAccount(accountId, { freeCredits: !(await isWorkspaceSplitTarget(accountId)) });
    return null;
  }

  const balance = Number(account.balance ?? 0);
  const tier = account.tier ?? 'none';
  const hasActiveSub =
    !!account.stripeSubscriptionId &&
    account.stripeSubscriptionStatus !== 'canceled' &&
    account.stripeSubscriptionStatus !== 'unpaid';

  if (hasActiveSub) return account;

  // A workspace without the free grant stays at 0: it buys credits.
  if (tier === 'none' && balance < MINIMUM_CREDIT_FOR_RUN && account.freeCreditsEligible !== false) {
    await initializeFreeTierAccount(accountId);
    return null;
  }
  return account;
}
