import Stripe from 'stripe';
import { wallet } from '../wallet';
import { applyStripeSync } from './account-write-owner';
import { getCreditAccount } from '../repositories/credit-accounts';
import { markTrialConverted } from './trial-admin';
import { upsertCustomer } from '../repositories/customers';
import { getTier, paidMonthlyUsd } from './tiers';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';

export function planKeyFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): string | undefined {
  return metadata?.plan_key || metadata?.tier_key || undefined;
}

/**
 * The monthly allowance a plan grants from this subscription: the subscription's
 * own amount on a paid plan (a comped $0 subscription keeps the row's amount),
 * the plan's fixed grant otherwise (free = $2).
 */
export function allowanceForSubscription(
  tierKey: string,
  subscription: Stripe.Subscription,
  row?: Parameters<typeof paidMonthlyUsd>[1],
): number {
  return tierKey === 'free' ? getTier('free').monthlyCredits : paidMonthlyUsd(subscription, row);
}

/**
 * Write the plan, grant the activation credit, and stitch up the customer /
 * previous-subscription side effects for a subscription whose first payment
 * has SETTLED.
 *
 * Two callers reach it, and both must have proven payment first:
 * - `handleSubscriptionCheckout`, when `session.payment_status === 'paid'`.
 * - `handleInvoicePaid` on billing_reason `subscription_create`, when the
 *   subscription status is a paying one.
 *
 * Nothing in here re-checks payment. The gate belongs to the callers, so this
 * function stays a single place that describes what activation IS.
 */
export async function activateSubscriptionForAccount(params: {
  accountId: string;
  subscription: Stripe.Subscription;
  subscriptionId: string;
  tierKey: string;
  commitmentType: string | null;
  previousSubscriptionIdHint: string | null;
  customerId: string | null;
  customerEmail: string | null;
}) {
  const {
    accountId,
    subscription,
    subscriptionId,
    tierKey,
    commitmentType,
    previousSubscriptionIdHint,
    customerId,
    customerEmail,
  } = params;

  const isYearly = commitmentType === 'yearly' || commitmentType === 'yearly_commitment';
  const existingAccount = await getCreditAccount(accountId);
  const previousSubscriptionId = previousSubscriptionIdHint
    ?? (
      existingAccount?.tier === 'free' &&
      existingAccount.stripeSubscriptionId &&
      existingAccount.stripeSubscriptionId !== subscriptionId
        ? existingAccount.stripeSubscriptionId
        : null
    );

  const monthlyUsd = allowanceForSubscription(tierKey, subscription, existingAccount);

  // For monthly plans, set next_credit_grant to the period-end so the
  // renewal loop knows when the next grant is due.
  const nextCreditGrantTs = isYearly
    ? calculateNextCreditGrant(new Date()).toISOString()
    : new Date(subscription.current_period_end * 1000).toISOString();

  await applyStripeSync(
    accountId,
    {
      tier: tierKey,
      planMonthlyUsd: tierKey === 'credits' ? String(monthlyUsd) : null,
      provider: 'stripe',
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionStatus: 'active',
      planType: isYearly ? 'yearly' : 'monthly',
      commitmentType: commitmentType === 'yearly_commitment' ? commitmentType : null,
      nextCreditGrant: nextCreditGrantTs,
      lastRenewalPeriodStart: subscription.current_period_start,
      autoTopupEnabled: true,
      ...(existingAccount?.autoTopupCustomized ? {} : {
        autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
        autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
      }),
    },
    { account: existingAccount, reason: 'subscription.activated' },
  );

  // A real subscription ends an admin-issued trial: mark it converted so the
  // trial overlay (resolve-billing.ts) stops masking the purchased plan.
  // `trial_status` is admin-owned, so it cannot ride along in the patch above —
  // it goes through the narrow cross-domain helper in trial-admin.ts.
  if (existingAccount?.trialStatus === 'active') {
    await markTrialConverted(accountId);
  }

  if (monthlyUsd > 0) {
    await wallet.grant({
      accountId,
      amount: monthlyUsd,
      kind: 'tier_grant',
      description: `${getTier(tierKey).displayName} plan activated: ${Math.round(monthlyUsd * 100)} credits`,
      expiring: true,
      key: { event: `subscription_activation:${subscriptionId}` },
    });
  }

  if (customerId) {
    await upsertCustomer({
      accountId,
      id: customerId,
      email: customerEmail,
      provider: 'stripe',
      active: true,
    });
  }

  if (previousSubscriptionId && previousSubscriptionId !== subscriptionId) {
    await cancelFreeSubscriptionForUpgrade(previousSubscriptionId, accountId);
  }

  console.log(`[Webhook] Subscription activated: ${tierKey} $${monthlyUsd}/mo for ${accountId} (sub=${subscriptionId})`);
}
