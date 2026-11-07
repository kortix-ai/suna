import { and, eq, ne } from 'drizzle-orm';
import { billingCustomers, creditAccounts } from '@kortix/db';
import { db } from '../../shared/db';
import { isUuid, listAccountWorkspaces } from '../../workspaces/surface';

/**
 * Legacy Stripe recovery: adopt a paid Credits subscription the account's
 * `credit_accounts` row does not name yet (a subscription bought before the
 * webhook mapped it, or after a Stripe account move).
 *
 * One workspace = one account = one Stripe customer, and one person's
 * customers all carry the same email. So the sync never matches by email
 * (design.md §3.1 finding 8). It adopts a subscription only when:
 *
 * - its customer is this account's own (a `billing_customers` row of this
 *   account), or has no `billing_customers` row at all; and
 * - its `metadata.account_id` is empty, names this account, or names an
 *   account that no longer exists (a legacy id); and
 * - no other `credit_accounts` row holds its id (invariant I11).
 *
 * Candidates: every `billing_customers` row of this account, plus the
 * customers of subscriptions whose `metadata.account_id` names this account
 * (Stripe search). It never rewrites a `metadata.account_id` that names
 * another live account. Only `POST /v1/billing/sync-subscription` runs it.
 */

export type LegacyStripeSyncResult = {
  status:
    | 'already_synced'
    | 'no_customer'
    | 'no_active_paid_subscription'
    | 'would_sync'
    | 'synced'
    | 'error';
  accountId: string;
  customerId?: string | null;
  customerEmail?: string | null;
  subscriptionId?: string | null;
  tier?: string | null;
  planType?: string | null;
  commitmentType?: string | null;
  metadataUpdated?: boolean;
  message?: string;
  error?: string;
};

export async function syncLegacyStripeSubscription(
  accountId: string,
  options: { dryRun?: boolean } = {},
): Promise<LegacyStripeSyncResult> {
  const dryRun = options.dryRun === true;

  try {
    const [existing] = await db
      .select({
        tier: creditAccounts.tier,
        provider: creditAccounts.provider,
        stripeSubscriptionId: creditAccounts.stripeSubscriptionId,
      })
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId))
      .limit(1);

    if (existing?.provider && existing.provider !== 'stripe') {
      return {
        status: 'already_synced',
        accountId,
        subscriptionId: existing?.stripeSubscriptionId ?? null,
        tier: existing?.tier ?? null,
        message: `Account is owned by ${existing.provider} billing`,
      };
    }

    if (existing?.stripeSubscriptionId) {
      return {
        status: 'already_synced',
        accountId,
        subscriptionId: existing?.stripeSubscriptionId ?? null,
        tier: existing?.tier ?? null,
        message: 'Account already has canonical billing state',
      };
    }

    const { getCustomerByAccountId, getCustomerByStripeId, upsertCustomer } = await import('../repositories/customers');
    const customer = await getCustomerByAccountId(accountId);
    const customerId = customer?.id ?? null;
    const customerEmail = customer?.email ?? null;
    const ownCustomerIds = await stripeCustomerIdsOf(accountId);

    const { getStripe } = await import('../../shared/stripe');
    const stripe = getStripe();
    const { billingPeriodForSubscription, monthlyCreditsForSubscription, planForSubscription } = await import('./tiers');
    const { applyStripeSync } = await import('./account-write-owner');
    const { wallet } = await import('../wallet');

    const candidateCustomerIds = new Set<string>(ownCustomerIds);
    // Subscriptions that name this account, on a customer that may not be
    // mapped yet. Never an email match: a person's workspaces share one email.
    for (const found of await subscriptionsNamingAccount(stripe, accountId)) {
      if (typeof found.customer === 'string') candidateCustomerIds.add(found.customer);
    }

    if (candidateCustomerIds.size === 0) {
      return {
        status: 'no_customer',
        accountId,
        message: 'No Stripe customer mapping found for account',
      };
    }

    for (const candidateCustomerId of candidateCustomerIds) {
      // A customer another account owns is that account's, whatever its email.
      if (!ownCustomerIds.has(candidateCustomerId)) {
        const mapped = await getCustomerByStripeId(candidateCustomerId);
        if (mapped && mapped.accountId !== accountId) continue;
      }
      try {
        const stripeCustomer = await stripe.customers.retrieve(candidateCustomerId);
        if ('deleted' in stripeCustomer && stripeCustomer.deleted) {
          continue;
        }
      } catch {
        continue;
      }

      const subscriptions = await stripe.subscriptions.list({
        customer: candidateCustomerId,
        status: 'active',
        limit: 10,
      });

      for (const subscription of subscriptions.data) {
        if (planForSubscription(subscription) !== 'credits') continue;
        if (await namesAnotherLiveAccount(subscription.metadata?.account_id, accountId)) continue;
        if (await subscriptionHeldElsewhere(subscription.id, accountId)) continue;
        const tierConfig = { name: 'credits' };
        const monthlyUsd = monthlyCreditsForSubscription(subscription);

        const billingPeriod = billingPeriodForSubscription(subscription);
        const planType = billingPeriod === 'yearly_commitment' ? 'yearly' : billingPeriod;
        const commitmentType = billingPeriod === 'yearly_commitment' ? 'yearly_commitment' : null;
        const shouldUpdateMetadata =
          subscription.metadata?.account_id !== accountId ||
          subscription.metadata?.tier_key !== tierConfig.name ||
          subscription.metadata?.billing_period !== billingPeriod ||
          (commitmentType
            ? subscription.metadata?.commitment_type !== commitmentType
            : !!subscription.metadata?.commitment_type);

        if (!dryRun && shouldUpdateMetadata) {
          const metadata: Record<string, string> = {
            ...subscription.metadata,
            account_id: accountId,
            tier_key: tierConfig.name,
            // Forward-compat alias, written in lockstep with tier_key. The
            // webhook resolves `plan_key ?? tier_key`, so any writer that sets
            // one and not the other would leave the OTHER one authoritative and
            // stale. See subscriptions.ts for the same pairing.
            plan_key: tierConfig.name,
            billing_period: billingPeriod,
          };

          // Only a dead (legacy) id reaches here: a live one was skipped above.
          if (subscription.metadata?.account_id && subscription.metadata.account_id !== accountId) {
            metadata.legacy_account_id = subscription.metadata.account_id;
          }

          if (commitmentType) {
            metadata.commitment_type = commitmentType;
          } else {
            delete metadata.commitment_type;
          }

          await stripe.subscriptions.update(subscription.id, { metadata });
        }

        const result: LegacyStripeSyncResult = {
          status: dryRun ? 'would_sync' : 'synced',
          accountId,
          customerId: candidateCustomerId,
          customerEmail,
          subscriptionId: subscription.id,
          tier: tierConfig.name,
          planType,
          commitmentType,
          metadataUpdated: shouldUpdateMetadata,
        };

        if (!dryRun) {
          await applyStripeSync(
            accountId,
            {
              tier: tierConfig.name,
              planMonthlyUsd: String(monthlyUsd),
              provider: 'stripe',
              stripeSubscriptionId: subscription.id,
              stripeSubscriptionStatus: subscription.status,
              billingCycleAnchor: subscription.billing_cycle_anchor
                ? new Date(subscription.billing_cycle_anchor * 1000).toISOString()
                : undefined,
              planType,
              commitmentType,
              commitmentEndDate: commitmentType && subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000).toISOString()
                : null,
            },
            { reason: 'legacy-stripe-sync' },
          );

          if (monthlyUsd > 0) {
            await wallet.reset({
              accountId,
              amount: monthlyUsd,
              description: `Recovered legacy Stripe subscription: ${Math.round(monthlyUsd * 100)} credits`,
              key: { event: `legacy_sync:${subscription.id}` },
            });
          }

          if (!ownCustomerIds.has(candidateCustomerId)) {
            await upsertCustomer({
              accountId,
              id: candidateCustomerId,
              email: customerEmail,
              active: true,
              provider: 'stripe',
            });
          }

          console.log(
            `[legacy-stripe-sync] Synced Stripe sub ${subscription.id} → tier=${tierConfig.name} for ${accountId} (customer=${candidateCustomerId})`,
          );
        }

        return result;
      }
    }

    return {
      status: 'no_active_paid_subscription',
      accountId,
      customerId,
      customerEmail,
      message: 'No active paid Stripe subscription found for mapped customer(s)',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      accountId,
      error: message,
      message: 'Legacy Stripe sync failed',
    };
  }
}

/** Every Stripe customer id mapped to this account (`billing_customers`), not only the canonical one. */
async function stripeCustomerIdsOf(accountId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: billingCustomers.id, provider: billingCustomers.provider })
    .from(billingCustomers)
    .where(eq(billingCustomers.accountId, accountId));
  return new Set(rows.filter((row) => !row.provider || row.provider === 'stripe').map((row) => row.id));
}

type StripeLike = ReturnType<typeof import('../../shared/stripe').getStripe>;

/** Active subscriptions whose `metadata.account_id` is this account. Search errors read as none. */
async function subscriptionsNamingAccount(stripe: StripeLike, accountId: string): Promise<Array<{ customer: unknown }>> {
  try {
    const found = await stripe.subscriptions.search({
      query: `status:'active' AND metadata['account_id']:'${accountId}'`,
      limit: 10,
    });
    return found.data;
  } catch {
    return [];
  }
}

/**
 * True when `metadataAccountId` names a live account other than `accountId`:
 * an account with a live workspace (active, dormant or closing). A legacy id
 * with no account behind it is not live, so the sync may adopt it.
 */
async function namesAnotherLiveAccount(metadataAccountId: string | null | undefined, accountId: string): Promise<boolean> {
  const named = metadataAccountId?.trim().toLowerCase();
  if (!named || named === accountId.toLowerCase()) return false;
  // Not a uuid: no account can carry it, but it is not ours either.
  if (!isUuid(named)) return true;
  return (await listAccountWorkspaces(named)).length > 0;
}

/** Invariant I11: one `credit_accounts` row per subscription id. */
async function subscriptionHeldElsewhere(subscriptionId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ accountId: creditAccounts.accountId })
    .from(creditAccounts)
    .where(and(eq(creditAccounts.stripeSubscriptionId, subscriptionId), ne(creditAccounts.accountId, accountId)))
    .limit(1);
  return Boolean(row);
}
