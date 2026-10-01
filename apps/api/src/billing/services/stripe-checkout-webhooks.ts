import Stripe from 'stripe';
import { getStripe } from '../../shared/stripe';
import { withAccountLock } from './webhook-concurrency';
import { updatePurchaseStatus, getPurchaseByPaymentIntent } from '../repositories/transactions';
import { wallet } from '../wallet';
import { isUuid } from '../../shared/validate';
import { applyStripeSync } from './account-write-owner';
import { getCreditAccount } from '../repositories/credit-accounts';
import { markTrialConverted } from './trial-admin';
import { upsertCustomer } from '../repositories/customers';
import { getTier, grantForSeats, resolvePerSeatPriceId, defaultAutoTopupForSeats } from './tiers';
import { grantMachineBonusOnce, getStripeMachineBonusKey } from './machine-bonus';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const accountId = session.metadata?.account_id;
  if (!accountId) {
    console.warn('[Webhook] checkout.session.completed missing account_id');
    return;
  }

  if (session.mode === 'payment') {
    await handleCreditPurchase(session, accountId);
    return;
  }

  if (session.mode === 'subscription') {
    await withAccountLock(accountId, () => handleSubscriptionCheckout(session, accountId));
  }
}

/** Mark the `credit_purchases` row this Checkout Session was created for. */
async function markCreditPurchase(session: Stripe.Checkout.Session, status: 'completed' | 'failed') {
  const completedAt = status === 'completed' ? new Date().toISOString() : undefined;
  const purchaseId = session.metadata?.purchase_id;
  if (purchaseId && isUuid(purchaseId)) {
    await updatePurchaseStatus(purchaseId, status, completedAt);
    return;
  }

  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;
  if (!paymentIntentId) return;
  const purchase = await getPurchaseByPaymentIntent(paymentIntentId);
  if (purchase) {
    await updatePurchaseStatus(purchase.id, status, completedAt);
  }
}

async function handleCreditPurchase(session: Stripe.Checkout.Session, accountId: string) {
  const amountTotal = (session.amount_total ?? 0) / 100;
  if (amountTotal <= 0) return;

  // Money first. Stripe fires `checkout.session.completed` as soon as the
  // customer finishes Checkout, including for delayed payment methods whose
  // funds have not arrived (`payment_status='unpaid'`). Those sessions are
  // fulfilled by `checkout.session.async_payment_succeeded`, which carries the
  // same session with `payment_status='paid'` and reaches this function again.
  // The grant key is the session id, so either event grants exactly once.
  if (session.payment_status !== 'paid') {
    console.log(
      `[Webhook] Credit purchase for ${accountId} deferred: session ${session.id} payment_status=${session.payment_status ?? 'unknown'}. Waiting for async_payment_succeeded.`,
    );
    return;
  }

  await wallet.grant({
    accountId,
    amount: amountTotal,
    kind: 'purchase',
    description: `Credit purchase: $${amountTotal.toFixed(2)}`,
    expiring: false,
    key: { event: session.id },
  });

  await markCreditPurchase(session, 'completed');

  console.log(`[Webhook] Credit purchase: $${amountTotal} for ${accountId}`);
}

/**
 * A delayed payment for a Checkout Session failed. A credit purchase granted
 * nothing when the session completed unpaid, so there is nothing to reverse;
 * only the purchase record changes. A subscription checkout stays deferred:
 * its activation waits for `invoice.paid`, which never arrives.
 */
export async function handleCheckoutAsyncPaymentFailed(session: Stripe.Checkout.Session) {
  const accountId = session.metadata?.account_id;
  if (!accountId) return;
  if (session.mode === 'payment') {
    await markCreditPurchase(session, 'failed');
  }
  console.log(
    `[Webhook] Delayed payment failed for ${accountId}: session ${session.id} (mode=${session.mode})`,
  );
}

async function handleSubscriptionCheckout(session: Stripe.Checkout.Session, accountId: string) {
  const tierKey = planKeyFromMetadata(session.metadata);
  if (!tierKey) return;

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;
  if (!subscriptionId) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // FRAUD GATE — money first, entitlements second.
  //
  // `checkout.session.completed` fires as soon as Stripe finishes the session,
  // INCLUDING when the first invoice was never paid. Such a session carries
  // `payment_status='unpaid'` and leaves the subscription at `incomplete`,
  // which expires to `incomplete_expired` after 23 hours with no money moved.
  // Activating here handed those sessions the full tier write AND the
  // activation credit grant: on production, 85 accounts holding
  // incomplete/incomplete_expired subscriptions burned $840 of granted credit
  // without ever paying (a signup farm).
  //
  // Record the subscription pointer only — no tier, no credits. Activation is
  // deferred to `invoice.paid` (billing_reason `subscription_create`), which
  // Stripe sends once the first invoice actually settles. That covers the
  // legitimate case this gate also catches: delayed payment methods
  // (bank debits, vouchers) whose checkout completes before the money does.
  if (session.payment_status !== 'paid') {
    await applyStripeSync(
      accountId,
      {
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionStatus: subscription.status,
        provider: 'stripe',
      },
      { reason: 'checkout.session.completed:deferred' },
    );
    console.log(
      `[Webhook] Deferred subscription activation for ${accountId} (sub=${subscriptionId}): checkout payment_status=${session.payment_status ?? 'unknown'}, subscription status=${subscription.status}. Waiting for invoice.paid.`,
    );
    return;
  }

  await activateSubscriptionForAccount({
    accountId,
    subscription,
    subscriptionId,
    tierKey,
    commitmentType: session.metadata?.commitment_type ?? null,
    previousSubscriptionIdHint: session.metadata?.previous_subscription_id ?? null,
    customerId: typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id ?? null,
    customerEmail: session.customer_email ?? null,
    serverType: session.metadata?.server_type ?? null,
    location: session.metadata?.location ?? null,
  });
}


/**
 * The plan a Stripe object names in its metadata.
 *
 * Resolution order is `plan_key ?? tier_key`. `plan_key` is the forward name
 * and every writer now sets BOTH in lockstep (subscriptions.ts,
 * legacy-stripe-sync.ts, and the metadata repairs in this file), so the two can
 * only disagree on an object created before `plan_key` existed — where
 * `tier_key` is the only answer there is. A price-id lookup is the last resort
 * and stays at the call sites that have a price.
 *
 * `||`, not `??`: Stripe deletes a metadata key by setting it to `''`, and an
 * empty string must fall through rather than resolve to a plan named "".
 */
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

