import { eq } from 'drizzle-orm';
import { creditAccounts } from '@kortix/db';
import { db } from '../../shared/db';

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

    const { getCustomerByAccountId, upsertCustomer } = await import('../repositories/customers');
    const customer = await getCustomerByAccountId(accountId);
    const customerId = customer?.id ?? null;
    const customerEmail = customer?.email ?? null;

    if (!customerId && !customerEmail) {
      return {
        status: 'no_customer',
        accountId,
        message: 'No Stripe customer mapping found for account',
      };
    }

    const { getStripe } = await import('../../shared/stripe');
    const stripe = getStripe();
    const { getBillingPeriodByPriceId, getTier, getTierByPriceId } = await import('./tiers');
    const { upsertCreditAccount } = await import('../repositories/credit-accounts');
    const { resetExpiringCredits } = await import('./credits');

    const candidateCustomerIds = new Set<string>();
    if (customerId) candidateCustomerIds.add(customerId);

    if (customerEmail) {
      const customers = await stripe.customers.search({
        query: `email:'${customerEmail.replace(/'/g, "\\'")}'`,
        limit: 10,
      });

      for (const match of customers.data) {
        candidateCustomerIds.add(match.id);
      }
    }

    for (const candidateCustomerId of candidateCustomerIds) {
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
        const priceId = subscription.items.data[0]?.price?.id;
        if (!priceId) continue;

        const tierConfig = getTierByPriceId(priceId);
        if (!tierConfig || tierConfig.name === 'free' || tierConfig.name === 'none') continue;

        const billingPeriod = getBillingPeriodByPriceId(priceId) ?? 'monthly';
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
            billing_period: billingPeriod,
          };

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
          const tier = getTier(tierConfig.name);

          await upsertCreditAccount(accountId, {
            tier: tierConfig.name,
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
          });

          if (tier.monthlyCredits > 0) {
            await resetExpiringCredits(
              accountId,
              tier.monthlyCredits,
              `Recovered legacy Stripe subscription: ${tier.monthlyCredits} credits`,
              `legacy_sync:${subscription.id}`,
            );
          }

          await upsertCustomer({
            accountId,
            id: candidateCustomerId,
            email: customerEmail,
            active: true,
            provider: 'stripe',
          });

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
