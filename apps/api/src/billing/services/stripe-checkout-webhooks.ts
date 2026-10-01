import Stripe from 'stripe';
import { wallet } from '../wallet';
import { applyStripeSync } from './account-write-owner';
import { getCreditAccount } from '../repositories/credit-accounts';
import { markTrialConverted } from './trial-admin';
import { upsertCustomer } from '../repositories/customers';
import { getTier, grantForSeats, resolvePerSeatPriceId, defaultAutoTopupForSeats } from './tiers';
import { grantMachineBonusOnce, getStripeMachineBonusKey } from './machine-bonus';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';

export function planKeyFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): string | undefined {
  return metadata?.plan_key || metadata?.tier_key || undefined;
}

/**
 * Write the tier, grant the activation credit, and stitch up the customer /
 * previous-subscription / machine-bonus side effects for a subscription whose
 * first payment has SETTLED.
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
  serverType: string | null;
  location: string | null;
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
    serverType,
    location,
  } = params;

  const tier = getTier(tierKey);
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

  // For per-seat plans, seat count drives the grant size and the
  // auto-topup defaults. Resolve from the subscription line item if available.
  const perSeatPriceId = resolvePerSeatPriceId();
  const perSeatItem = subscription.items.data.find(
    (item) => (perSeatPriceId && item.price?.id === perSeatPriceId) ||
      subscription.metadata?.billing_model === 'per_seat',
  );
  const seatCount = perSeatItem ? Math.max(1, Math.floor(perSeatItem.quantity ?? 1)) : 1;
  const isPerSeat = tierKey === 'per_seat' || !!perSeatItem;

  // For monthly plans, set next_credit_grant to the period-end so the
  // renewal loop knows when the next grant is due. Previously this was only
  // set for yearly plans, leaving monthly accounts with next_credit_grant=NULL
  // and no way for the cron to know they needed a grant.
  const nextCreditGrantTs = isYearly
    ? calculateNextCreditGrant(new Date()).toISOString()
    : new Date(subscription.current_period_end * 1000).toISOString();

  const perSeatAutoTopupDefaults = isPerSeat && !existingAccount?.autoTopupCustomized
    ? defaultAutoTopupForSeats(seatCount)
    : null;

  await applyStripeSync(
    accountId,
    {
      tier: tierKey,
      provider: 'stripe',
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionStatus: 'active',
      planType: isYearly ? 'yearly' : 'monthly',
      commitmentType: commitmentType === 'yearly_commitment' ? commitmentType : null,
      nextCreditGrant: nextCreditGrantTs,
      lastRenewalPeriodStart: subscription.current_period_start,
      ...(isPerSeat ? {
        billingModel: 'per_seat',
        seatCount,
        ...(perSeatAutoTopupDefaults ? {
          autoTopupThreshold: String(perSeatAutoTopupDefaults.threshold),
          autoTopupAmount: String(perSeatAutoTopupDefaults.amount),
        } : {}),
      } : {}),
      autoTopupEnabled: true,
      autoTopupThreshold: String(perSeatAutoTopupDefaults?.threshold ?? AUTO_TOPUP_DEFAULT_THRESHOLD),
      autoTopupAmount: String(perSeatAutoTopupDefaults?.amount ?? AUTO_TOPUP_DEFAULT_AMOUNT),
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

  // For per-seat: grant grantForSeats(seatCount) so 1 seat → $25, 3 seats → $75, etc.
  // For legacy tiers: grant tier.monthlyCredits (unchanged behaviour).
  const creditAmount = isPerSeat ? grantForSeats(seatCount) : tier.monthlyCredits;
  const creditDesc = isPerSeat
    ? `${tier.displayName} subscription activated: ${creditAmount} credits (${seatCount} ${seatCount === 1 ? 'seat' : 'seats'})`
    : `${tier.displayName} subscription activated: ${creditAmount} credits`;

  if (creditAmount > 0) {
    await wallet.grant({
      accountId,
      amount: creditAmount,
      kind: 'tier_grant',
      description: creditDesc,
      expiring: true,
      key: { event: `subscription_activation:${subscriptionId}` },
    });
  }

  // Upsert Stripe customer record
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

  if (serverType) {
    try {
      await grantMachineBonusOnce({
        accountId,
        idempotencyKey: getStripeMachineBonusKey(subscriptionId),
      });
      console.log(`[Webhook] Granted machine bonus for ${accountId} (sub=${subscriptionId})`);
    } catch (err) {
      console.error(`[Webhook] Failed to grant machine bonus for ${accountId} (sub=${subscriptionId}):`, err);
    }

    void serverType;
    void location;
    void tierKey;
  }

  console.log(`[Webhook] Subscription activated: ${tierKey} for ${accountId} (sub=${subscriptionId})`);
}

