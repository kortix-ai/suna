import Stripe from 'stripe';
import { getStripe } from '../../shared/stripe';
import { isWebhookEventProcessed, recordWebhookEvent, withAccountLock } from './webhook-concurrency';
import { config } from '../../config';
import { WebhookError } from '../../errors';
import { getCreditAccount } from '../repositories/credit-accounts';
import { applyStripeSync } from './account-write-owner';
import { markTrialConverted } from './trial-admin';
import { getCustomerByStripeId } from '../repositories/customers';
import {
  getBillingPeriodByPriceId,
  getTier,
  getTierByPriceId,
  getMonthlyCredits,
  grantForSeats,
  defaultAutoTopupForSeats,
  isPerSeatAccount,
  resolveRenewalGrant,
  resolvePerSeatPriceId,
} from './tiers';
import { grantForPaidProrationInvoice } from './proration-grants';
import { wallet } from '../wallet';
import { isPayingSubscriptionStatus } from './billing-state';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';
import { handleCheckoutCompleted, handleCheckoutAsyncPaymentFailed, planKeyFromMetadata, activateSubscriptionForAccount } from './stripe-checkout-webhooks';

/** Both spellings of the plan key, for writing Stripe subscription metadata. */
function planKeyMetadata(planKey: string): { tier_key: string; plan_key: string } {
  return { tier_key: planKey, plan_key: planKey };
}

export async function processStripeWebhook(rawBody: string, signature: string) {
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
    bindIntegrationPrincipal('stripe');
  } catch (err) {
    throw new WebhookError(`Signature verification failed: ${(err as Error).message}`);
  }

  // The dedupe marker is written AFTER the handler succeeds, never before. A
  // marker written first survives a process death mid-handler (deploy, OOM),
  // and Stripe's retry would then be answered "duplicate" and the event lost.
  // Every handler below is idempotent on its own (grants carry per-object
  // ledger keys, account writes are upserts of provider state), so a retry of
  // a half-finished event, or two overlapping deliveries, converge.
  if (await isWebhookEventProcessed(event.id)) {
    console.log(`[Webhook] Skipping duplicate ${event.type} (${event.id})`);
    return { received: true, event_type: event.type, deduped: true };
  }

  console.log(`[Webhook] Processing ${event.type} (${event.id})`);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;

    // A delayed payment method (ACH debit, bank transfer) completes Checkout
    // before the money arrives: `checkout.session.completed` carries
    // `payment_status='unpaid'` and grants nothing. These two events report
    // the outcome.
    case 'checkout.session.async_payment_succeeded':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;

    case 'checkout.session.async_payment_failed':
      await handleCheckoutAsyncPaymentFailed(event.data.object as Stripe.Checkout.Session);
      break;

    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed': {
      const { settleAutoTopupPaymentIntent } = await import('./auto-topup');
      await settleAutoTopupPaymentIntent(event.data.object as Stripe.PaymentIntent);
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionChange(event.data.object as Stripe.Subscription);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;

    case 'invoice.paid':
      await handleInvoicePaid(event.data.object as Stripe.Invoice);
      break;

    case 'invoice.payment_failed':
      await handleInvoiceFailed(event.data.object as Stripe.Invoice);
      break;

    case 'subscription_schedule.completed':
      await handleScheduleCompleted(event.data.object as any);
      break;

    case 'subscription_schedule.released':
      console.log(`[Webhook] Schedule released: ${(event.data.object as any).id}`);
      break;

    default:
      console.log(`[Webhook] Unhandled event type: ${event.type}`);
  }

  await recordWebhookEvent(event.id, event.type);
  return { received: true, event_type: event.type };
}

async function handleSubscriptionChange(subscription: Stripe.Subscription) {
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) {
    console.warn('[Webhook] subscription change: no canonical account_id');
    return;
  }

  await repairStripeSubscriptionAccountMetadata(subscription, accountId);
  await withAccountLock(accountId, () => syncSubscriptionState(accountId, subscription));
}

async function syncSubscriptionState(accountId: string, subscription: Stripe.Subscription) {
  const account = await getCreditAccount(accountId);
  if (account?.stripeSubscriptionId && account.stripeSubscriptionId !== subscription.id) {
    const previousSubId = subscription.metadata?.previous_subscription_id;
    const currentTier = account.tier ?? 'free';
    const incomingTier = planKeyFromMetadata(subscription.metadata);
    const isFreeUpgrade =
      currentTier === 'free' &&
      incomingTier &&
      incomingTier !== 'free' &&
      subscription.status === 'active' &&
      previousSubId === account.stripeSubscriptionId;

    // A legacy/machine account migrating to per-seat: the new per-seat sub
    // supersedes the old one but carries metadata.billing_model='per_seat' (or
    // the per-seat price) rather than tier_key/previous_subscription_id, so
    // isFreeUpgrade misses it. Adopt it — otherwise it's dropped as "stale" and
    // the account is left on the now-cancelled machine sub (tier=free, capped).
    const perSeatPriceId = resolvePerSeatPriceId();
    const isPerSeatActivation =
      (subscription.status === 'active' || subscription.status === 'trialing') &&
      (subscription.metadata?.billing_model === 'per_seat' ||
        subscription.items.data.some((item) => perSeatPriceId && item.price?.id === perSeatPriceId));

    // Orphaned-plan-sub recovery: the account's stored subscription pointer
    // points at a *different* sub (typically a now-deleted machine sub that
    // hijacked the row via upsertCreditAccount), while the incoming event is
    // for the customer's still-active plan subscription. When the stored sub
    // is dead (canceled/unpaid/expired) and the incoming one is live, adopt
    // the incoming sub instead of dropping it as "stale" — otherwise the
    // account is stranded on a dead pointer and the paywall blocks a paying
    // customer forever.
    const deadStatuses = ['canceled', 'unpaid', 'incomplete_expired'];
    const currentSubIsDead = deadStatuses.includes(account.stripeSubscriptionStatus ?? '')
      || account.paymentStatus === 'cancelling';
    const incomingSubIsLive = subscription.status === 'active' || subscription.status === 'trialing';
    const isOrphanedPlanRecovery =
      incomingSubIsLive &&
      currentSubIsDead &&
      // Don't adopt a machine sub (server_type) over a dead plan pointer; only
      // adopt a genuine plan subscription (tier_key present, non-machine).
      !!incomingTier && incomingTier !== 'free' && !subscription.metadata?.server_type;

    if (isFreeUpgrade) {
      console.log(
        `[Webhook] syncSubscriptionState: detected free→${incomingTier} upgrade for ${accountId}, cancelling old free sub ${account.stripeSubscriptionId}`,
      );
      await cancelFreeSubscriptionForUpgrade(account.stripeSubscriptionId, accountId);
    } else if (isPerSeatActivation) {
      console.log(`[Webhook] syncSubscriptionState: adopting per-seat subscription ${subscription.id} superseding ${account.stripeSubscriptionId} for ${accountId}`);
    } else if (isOrphanedPlanRecovery) {
      console.log(
        `[Webhook] syncSubscriptionState: adopting orphaned-plan subscription ${subscription.id} for ${accountId} (stored sub ${account.stripeSubscriptionId} is dead, status=${account.stripeSubscriptionStatus}, paymentStatus=${account.paymentStatus})`,
      );
    } else {
      console.log(`[Webhook] syncSubscriptionState: skipping stale subscription ${subscription.id} for ${accountId} (current: ${account.stripeSubscriptionId})`);
      return;
    }
  }

  const tierKey = planKeyFromMetadata(subscription.metadata);
  const priceId = subscription.items.data[0]?.price?.id;
  const resolvedTier = tierKey ?? getTierByPriceId(priceId ?? '')?.name ?? null;
  const billingPeriod = getBillingPeriodByPriceId(priceId ?? '') ?? (subscription.metadata?.commitment_type as any) ?? 'monthly';
  // Grant recovery credits when the account had no sub pointer, was on a dead
  // machine/free sub, OR is being recovered from an orphaned-plan-sub state
  // (the stored pointer pointed at a dead sub while a live plan sub was being
  // adopted above). In all these cases the balance is likely $0 and the
  // customer was paywalled through no fault of their own.
  //
  // Gated on `subIsPaying` for the same reason the checkout path is: a
  // `customer.subscription.created` for an `incomplete` subscription is not a
  // customer, it is an unpaid attempt. Recovery credit for one is a pure gift.
  const subIsPaying = isPayingSubscriptionStatus(subscription.status);
  const shouldGrantRecoveryCredits =
    !!resolvedTier &&
    subIsPaying &&
    (!account || (!account.stripeSubscriptionId && (!account.tier || account.tier === 'free' || account.tier === 'none')));

  console.log(`[Webhook] syncSubscriptionState: account=${accountId} tier_meta=${tierKey} price=${priceId} resolved=${resolvedTier} status=${subscription.status} paying=${subIsPaying}`);

  const updates: Record<string, any> = {
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionStatus: subscription.status,
    billingCycleAnchor: new Date(subscription.billing_cycle_anchor * 1000).toISOString(),
    provider: 'stripe',
    planType: billingPeriod === 'yearly_commitment' ? 'yearly' : billingPeriod,
    commitmentType: billingPeriod === 'yearly_commitment' ? 'yearly_commitment' : null,
    commitmentEndDate: billingPeriod === 'yearly_commitment'
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
  };

  // Tier is an ENTITLEMENT, and entitlements follow money. A subscription that
  // is `incomplete` (first invoice never paid) or `incomplete_expired` (first
  // invoice never paid, and now it never will be) must not write a paid tier.
  // Every other field above is factual bookkeeping and is written regardless.
  if (resolvedTier && subIsPaying) {
    updates.tier = resolvedTier;
  }

  if (subscription.cancel_at_period_end) {
    updates.paymentStatus = 'cancelling';
  } else if (subscription.status === 'active') {
    updates.paymentStatus = 'active';
  }

  const perSeatPriceId = resolvePerSeatPriceId();
  const perSeatItem = subscription.items.data.find(
    (item) =>
      (perSeatPriceId && item.price?.id === perSeatPriceId) ||
      subscription.metadata?.billing_model === 'per_seat',
  );
  let perSeatNewSeats = 0;
  // Same gate as the tier write. Seat count and billing model are entitlements
  // bought with the first invoice; an `incomplete` per-seat subscription has
  // bought none of them yet.
  //
  // This handler never grants the allowance for seats added mid-period. A
  // quantity change is not a payment: Stripe reports it here before any money
  // for the new seats is collected. The allowance for added seats is granted
  // from the PAID proration invoice instead (proration-grants.ts).
  if (perSeatItem && subIsPaying) {
    const newSeats = Math.max(1, Math.floor(perSeatItem.quantity ?? 1));
    perSeatNewSeats = newSeats;
    // Per-seat BILLING semantics live on `billing_model`, `seat_count`, and the
    // seat item id — never on `tier`. All three are written unconditionally:
    // seat grants, auto-topup scaling, and compute metering key off
    // `billing_model`, so an enterprise-entitled account still reconciles them.
    updates.billingModel = 'per_seat';
    updates.seatCount = newSeats;
    updates.seatSubscriptionItemId = perSeatItem.id;
    // `tier` is asserted plainly. The ad-hoc "unless enterprise-entitled" branch
    // that used to sit here is gone: it protected exactly this one write while
    // the price-resolved tier, the never-paid reset, revertToFree, the scheduled
    // downgrade, and the RevenueCat expiry all still clobbered. The pin rule now
    // lives once, in applyStripeSync, and covers every one of them.
    updates.tier = 'per_seat';

    // Apply scaled auto-topup defaults if the user hasn't customised them.
    if (!account?.autoTopupCustomized) {
      const defaults = defaultAutoTopupForSeats(newSeats);
      updates.autoTopupThreshold = String(defaults.threshold);
      updates.autoTopupAmount = String(defaults.amount);
    }
  }

  // A real, paying subscription ends an admin-issued trial. Only paying
  // statuses count — an incomplete/past_due sub must not eat the trial the
  // account is still evaluating on. Decided here, written after the sync below:
  // `trial_status` is admin-owned and may not ride along in a provider patch.
  const trialConvertedByThisSub =
    account?.trialStatus === 'active' &&
    !!(updates.tier || perSeatItem) &&
    (subscription.status === 'active' || subscription.status === 'trialing');

  // NEVER-PAID RESET — revoke a tier this subscription should never have granted.
  //
  // `incomplete_expired` has exactly one meaning in Stripe: the first invoice
  // was never paid, and Stripe has given up collecting it. No money EVER moved
  // on this subscription. Rows written before the payment gate above landed
  // (85 production accounts, $840 of granted credit) still carry the paid tier
  // that this subscription handed out, and nothing else would ever take it
  // back — `customer.subscription.deleted` does not fire for a subscription
  // that expired without activating.
  //
  // Deliberately narrow. It only fires when the account still points at THIS
  // subscription and still holds the exact tier THIS subscription granted, so
  // it can never strip a tier that some other subscription, a migration, or an
  // operator granted. `enterprise_entitled` accounts are never touched: their
  // entitlement is contracted, not Stripe-derived.
  const neverPaidTierGrantedByThisSub =
    subscription.status === 'incomplete_expired' &&
    account &&
    account.stripeSubscriptionId === subscription.id &&
    !account.enterpriseEntitled &&
    account.tier &&
    !['free', 'none'].includes(account.tier) &&
    (account.tier === resolvedTier || (!!perSeatItem && account.tier === 'per_seat'));

  if (neverPaidTierGrantedByThisSub) {
    console.log(
      `[Webhook] syncSubscriptionState: revoking never-paid tier '${account!.tier}' for ${accountId} (sub=${subscription.id} is incomplete_expired — first invoice was never paid)`,
    );
    updates.tier = 'free';
    if (account!.billingModel === 'per_seat') {
      updates.billingModel = 'legacy';
    }
  }

  await applyStripeSync(accountId, updates, {
    account,
    // A missing row is CREATED here (the account's first subscription event);
    // an existing row is patched in place.
    mode: account ? 'update' : 'upsert',
    reason: 'customer.subscription.sync',
  });

  if (trialConvertedByThisSub) {
    await markTrialConverted(accountId);
  }

  // A per-seat recovery must be sized by SEATS. getMonthlyCredits('per_seat')
  // returns the per-seat allowance for ONE seat ($25) and knows nothing about
  // seat_count, so a recovering 6-seat team used to be reset to $25 instead of
  // $150 — visible in production as 41 ledger rows reading exactly
  // "Recovered Stripe subscription: 25 credits" regardless of team size.
  const recoveryCredits = resolvedTier
    ? perSeatItem
      ? grantForSeats(perSeatNewSeats)
      : getMonthlyCredits(resolvedTier)
    : 0;

  if (shouldGrantRecoveryCredits && resolvedTier) {
    if (recoveryCredits > 0) {
      await wallet.reset({
        accountId,
        amount: recoveryCredits,
        description: `Recovered Stripe subscription: ${recoveryCredits} credits`,
        key: { event: `subscription_activation:${subscription.id}` },
      });
    }
  }

  // Minting seat tokens is NOT part of any grant decision and must not be
  // nested inside one. A brand-new per-seat team needs its tokens whether or
  // not a recovery reset funded it.
  if (perSeatItem && !isPerSeatAccount(account?.billingModel)) {
    const { mintYoloTokensForAllMembers } = await import('./seat-management');
    void mintYoloTokensForAllMembers(accountId).catch((err) =>
      console.warn(`[Webhook] mint YOLO tokens for existing members failed for ${accountId}:`, err),
    );
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) return;

  await withAccountLock(accountId, async () => {
    const account = await getCreditAccount(accountId);
    if (account?.stripeSubscriptionId && account.stripeSubscriptionId !== subscription.id) {
      console.log(
        `[Webhook] handleSubscriptionDeleted: skipping stale subscription ${subscription.id} for ${accountId} (current: ${account.stripeSubscriptionId})`,
      );
      return;
    }
    // Before reverting to free, check whether the customer has *another* active
    // subscription in Stripe (e.g. a paid plan sub that was orphaned when a
    // machine sub hijacked the credit_accounts row). If so, re-stitch the row
    // to that sub instead of stranding the customer on free with no credits.
    const restored = await tryRestoreOtherActiveSubscription(accountId, subscription, account);
    if (restored) return;
    await revertToFree(accountId, subscription.id, account);
  });
}

/**
 * When a subscription is deleted, the customer may still have another active
 * subscription in Stripe (the classic case: a machine/compute sub hijacked the
 * credit_accounts.stripeSubscriptionId pointer, then got deleted, while the real
 * paid-plan sub is still live). This queries Stripe for any other active sub
 * on the same customer and, if found, re-syncs the row to it so the customer
 * isn't stranded on free.
 *
 * Returns true if a restoration happened (row repointed), false to fall
 * through to revertToFree.
 */
async function tryRestoreOtherActiveSubscription(
  accountId: string,
  deletedSubscription: Stripe.Subscription,
  account: Awaited<ReturnType<typeof getCreditAccount>>,
): Promise<boolean> {
  const customerId = typeof deletedSubscription.customer === 'string'
    ? deletedSubscription.customer
    : deletedSubscription.customer?.id;
  if (!customerId) return false;

  let otherSubs: Stripe.Subscription[];
  try {
    const stripe = getStripe();
    const list = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 10,
    });
    otherSubs = list.data.filter(
      (s) => s.id !== deletedSubscription.id && (s.status === 'active' || s.status === 'trialing'),
    );
  } catch (err) {
    console.error(`[Webhook] tryRestoreOtherActiveSubscription: failed to list subscriptions for ${accountId}:`, err);
    return false;
  }

  if (otherSubs.length === 0) return false;

  // Prefer a non-machine (plan) subscription — one without server_type
  // metadata and with a real tier_key — over a machine sub.
  const planSub = otherSubs.find((s) => {
    const key = planKeyFromMetadata(s.metadata);
    return !!key && key !== 'free' && !s.metadata?.server_type;
  });
  const target = planSub ?? otherSubs[0];

  console.log(
    `[Webhook] handleSubscriptionDeleted: restoring ${accountId} to other active subscription ${target.id} (tier=${planKeyFromMetadata(target.metadata) ?? 'unknown'}) instead of reverting to free`,
  );
  // Repoint the account to the surviving subscription directly. We don't call
  // syncSubscriptionState here because its stale-sub guard would bail (the
  // stored stripeSubscriptionId is the deleted sub, ≠ the target sub). The
  // target sub is already active/trialing (we filtered for that), so we
  // resolve its tier and apply the update inline.
  const targetTierKey = planKeyFromMetadata(target.metadata);
  const targetPriceId = target.items?.data?.[0]?.price?.id;
  const resolvedTier = targetTierKey ?? getTierByPriceId(targetPriceId ?? '')?.name ?? null;
  const billingPeriod = getBillingPeriodByPriceId(targetPriceId ?? '') ?? (target.metadata?.commitment_type as any) ?? 'monthly';

  const updates: Record<string, any> = {
    stripeSubscriptionId: target.id,
    stripeSubscriptionStatus: target.status,
    billingCycleAnchor: new Date(target.billing_cycle_anchor * 1000).toISOString(),
    provider: 'stripe',
    planType: billingPeriod === 'yearly_commitment' ? 'yearly' : billingPeriod,
    commitmentType: billingPeriod === 'yearly_commitment' ? 'yearly_commitment' : null,
    commitmentEndDate: billingPeriod === 'yearly_commitment'
      ? new Date(target.current_period_end * 1000).toISOString()
      : null,
    paymentStatus: target.cancel_at_period_end ? 'cancelling' : 'active',
  };
  if (resolvedTier) {
    updates.tier = resolvedTier;
  }
  await applyStripeSync(accountId, updates, {
    account,
    mode: 'update',
    reason: 'customer.subscription.deleted:restore',
  });
  return true;
}

async function revertToFree(
  accountId: string,
  subscriptionId: string | undefined,
  account: Awaited<ReturnType<typeof getCreditAccount>>,
) {
  void subscriptionId;

  // `tier: 'free'` is a legitimate provider write — the subscription that paid
  // for the tier is gone. It is still subject to the pin rule: an
  // enterprise-entitled account keeps its tier and loses only the Stripe
  // bookkeeping, because its entitlement came from a contract, not this sub.
  await applyStripeSync(
    accountId,
    {
      tier: 'free',
      stripeSubscriptionStatus: 'canceled',
      scheduledTierChange: null,
      scheduledTierChangeDate: null,
      scheduledPriceId: null,
      commitmentType: null,
      commitmentEndDate: null,
      paymentStatus: 'active',
    },
    { account, mode: 'update', reason: 'customer.subscription.deleted:revert' },
  );
  console.log(`[Webhook] Reverted to free tier: ${accountId}`);
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id;
  if (!subscriptionId) return;

  // `subscription_cycle` is a renewal. `subscription_create` is the FIRST
  // invoice of a new subscription actually settling — the event that proves
  // money moved, and therefore the only trustworthy activation trigger.
  // `subscription_update` is a proration invoice for a mid-period change (added
  // seats, a plan upgrade) that has now been PAID.
  const billingReason = invoice.billing_reason;
  if (
    billingReason !== 'subscription_cycle' &&
    billingReason !== 'subscription_create' &&
    billingReason !== 'subscription_update'
  ) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) return;

  await repairStripeSubscriptionAccountMetadata(subscription, accountId);

  if (billingReason === 'subscription_create') {
    await activateOnFirstInvoicePaid(accountId, subscription, subscriptionId);
    return;
  }

  if (billingReason === 'subscription_update') {
    await grantForPaidProrationInvoice(accountId, invoice);
    return;
  }

  const account = await getCreditAccount(accountId);
  if (!account) return;

  const periodStart = invoice.period_start;
  if (account.lastRenewalPeriodStart && account.lastRenewalPeriodStart >= periodStart) {
    console.log(`[Webhook] Renewal already processed for period ${periodStart}`);
    return;
  }

  if (account.scheduledTierChange) {
    await applyScheduledDowngrade(accountId, account.scheduledTierChange, account);
  }

  const tierName = account.scheduledTierChange ?? account.tier ?? 'free';

  // ONE renewal-grant rule, resolved from the subscription that was billed —
  // per-seat by seats, configured tiers by their grant, and every other PAID
  // legacy subscription by the invoice amount (see resolveRenewalGrant).
  const { credits, description: renewalDesc } = resolveRenewalGrant({
    tierName,
    billingModel: account.billingModel,
    seatCount: account.seatCount,
    amountPaidUsd: (invoice.amount_paid ?? 0) / 100,
  });

  if (credits > 0) {
    await wallet.reset({ accountId, amount: credits, description: renewalDesc, key: { event: invoice.id } });
  }

  const planType = account.planType ?? 'monthly';
  const nextCreditGrant = planType === 'yearly'
    ? calculateNextCreditGrant(new Date()).toISOString()
    : new Date(subscription.current_period_end * 1000).toISOString();

  await applyStripeSync(
    accountId,
    {
      lastRenewalPeriodStart: periodStart,
      lastProcessedInvoiceId: invoice.id,
      lastGrantDate: new Date().toISOString(),
      nextCreditGrant,
    },
    { account, mode: 'update', reason: 'invoice.paid:renewal' },
  );

  console.log(`[Webhook] Renewal processed: ${credits} credits for ${accountId}`);
}

/**
 * Activate a subscription whose FIRST invoice has just been paid
 * (`invoice.paid`, billing_reason `subscription_create`).
 *
 * This is the money-first counterpart to the checkout path. It is what
 * activates a delayed-payment-method checkout — bank debit, voucher, 3DS
 * finished late — where `checkout.session.completed` arrived with
 * `payment_status='unpaid'` and was deferred on purpose.
 *
 * IDEMPOTENT WITH THE CHECKOUT PATH. Running both for the same subscription
 * grants once and converges on the same row:
 * - the activation credit grant shares the
 *   `subscription_activation:${subscriptionId}` idempotency key with
 *   `handleSubscriptionCheckout` (and with syncSubscriptionState's recovery
 *   reset), so the second caller is deduped by the credits ledger;
 * - the machine bonus is guarded by `grantMachineBonusOnce`;
 * - every other write (`upsertCreditAccount`, `upsertCustomer`) is an upsert
 *   with identical values, and `cancelFreeSubscriptionForUpgrade` is a no-op
 *   for an already-cancelled subscription.
 */
async function activateOnFirstInvoicePaid(
  accountId: string,
  subscription: Stripe.Subscription,
  subscriptionId: string,
) {
  // Stripe can send `invoice.paid` for an invoice that was paid out-of-band on
  // a subscription that is still not collecting. Require a paying status.
  if (!isPayingSubscriptionStatus(subscription.status)) {
    console.log(
      `[Webhook] invoice.paid(subscription_create): skipping activation for ${accountId} (sub=${subscriptionId} status=${subscription.status} is not a paying status)`,
    );
    return;
  }

  const priceId = subscription.items.data[0]?.price?.id;
  const tierKey = planKeyFromMetadata(subscription.metadata) ?? getTierByPriceId(priceId ?? '')?.name;
  if (!tierKey) {
    console.warn(
      `[Webhook] invoice.paid(subscription_create): no tier for ${accountId} (sub=${subscriptionId} price=${priceId ?? 'none'})`,
    );
    return;
  }

  await withAccountLock(accountId, () =>
    activateSubscriptionForAccount({
      accountId,
      subscription,
      subscriptionId,
      tierKey,
      commitmentType: subscription.metadata?.commitment_type ?? null,
      previousSubscriptionIdHint: null,
      customerId: typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id ?? null,
      customerEmail: null,
      serverType: null,
      location: null,
    }),
  );
}

async function applyScheduledDowngrade(accountId: string, targetTier: string, account: any) {
  const tier = getTier(targetTier);
  if (account.stripeSubscriptionId && account.scheduledPriceId) {
    try {
      const stripe = getStripe();
      const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);
      const currentPriceId = subscription.items.data[0]?.price?.id;

      if (currentPriceId === account.scheduledPriceId) {
        await stripe.subscriptions.update(account.stripeSubscriptionId, {
          metadata: { ...subscription.metadata, ...planKeyMetadata(targetTier), downgrade: '', target_tier: '' },
        });
        console.log(`[Webhook] Price already correct (schedule applied), updated metadata for ${accountId}`);
      } else {
        await stripe.subscriptions.update(account.stripeSubscriptionId, {
          items: [{ id: subscription.items.data[0].id, price: account.scheduledPriceId }],
          proration_behavior: 'none',
          metadata: { ...subscription.metadata, ...planKeyMetadata(targetTier), downgrade: '', target_tier: '' },
        });
        console.log(`[Webhook] Stripe price updated to ${account.scheduledPriceId} for ${accountId}`);
      }
    } catch (err) {
      console.error(`[Webhook] Failed to update Stripe subscription for ${accountId}:`, err);
    }
  }

  await applyStripeSync(
    accountId,
    {
      tier: targetTier,
      scheduledTierChange: null,
      scheduledTierChangeDate: null,
      scheduledPriceId: null,
    },
    { account, mode: 'update', reason: 'invoice.paid:scheduled_downgrade' },
  );

  console.log(`[Webhook] Applied scheduled downgrade to ${tier.displayName} for ${accountId}`);
}

async function handleScheduleCompleted(schedule: any) {
  const accountId = schedule.metadata?.account_id;
  if (!accountId) {
    console.log(`[Webhook] subscription_schedule.completed: no account_id in metadata`);
    return;
  }

  const targetTier = schedule.metadata?.target_tier;
  const isDowngrade = schedule.metadata?.downgrade === 'true';

  if (targetTier && isDowngrade) {
    console.log(`[Webhook] Schedule completed: downgrade to ${targetTier} for ${accountId}`);

    await applyStripeSync(
      accountId,
      {
        tier: targetTier,
        scheduledTierChange: null,
        scheduledTierChangeDate: null,
        scheduledPriceId: null,
      },
      { mode: 'update', reason: 'subscription_schedule.completed' },
    );

    const subscriptionId = typeof schedule.subscription === 'string'
      ? schedule.subscription
      : schedule.subscription?.id;

    if (subscriptionId) {
      const stripe = getStripe();
      try {
        await stripe.subscriptions.update(subscriptionId, {
          metadata: { ...planKeyMetadata(targetTier), downgrade: '', target_tier: '', scheduled_change: '' },
        });
      } catch (err) {
        console.error(`[Webhook] Failed to update subscription metadata after schedule completion:`, err);
      }
    }
  }
}

async function handleInvoiceFailed(invoice: Stripe.Invoice) {
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id;
  if (!subscriptionId) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) return;

  await repairStripeSubscriptionAccountMetadata(subscription, accountId);

  await applyStripeSync(
    accountId,
    {
      paymentStatus: 'past_due',
      lastPaymentFailure: new Date().toISOString(),
    },
    { mode: 'update', reason: 'invoice.payment_failed' },
  );

  console.log(`[Webhook] Payment failed for ${accountId}`);
}

async function resolveCanonicalStripeAccountId(
  rawAccountId: string | undefined,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): Promise<string | null> {
  const customerId = typeof customer === 'string'
    ? customer
    : ('id' in (customer ?? {}) ? (customer as Stripe.Customer | Stripe.DeletedCustomer).id : null);

  if (customerId) {
    const mappedCustomer = await getCustomerByStripeId(customerId);
    if (mappedCustomer?.accountId) {
      return mappedCustomer.accountId;
    }
  }

  return rawAccountId ?? null;
}

async function repairStripeSubscriptionAccountMetadata(subscription: Stripe.Subscription, canonicalAccountId: string) {
  const rawAccountId = subscription.metadata?.account_id;
  if (!rawAccountId || rawAccountId === canonicalAccountId) return;

  try {
    const stripe = getStripe();
    await stripe.subscriptions.update(subscription.id, {
      metadata: {
        ...subscription.metadata,
        account_id: canonicalAccountId,
        legacy_account_id: rawAccountId,
      },
    });
    console.log(`[Webhook] Repaired subscription ${subscription.id} account_id ${rawAccountId} -> ${canonicalAccountId}`);
  } catch (err) {
    console.error(`[Webhook] Failed to repair subscription ${subscription.id} account metadata:`, err);
  }
}

export { processRevenueCatWebhook } from './revenuecat-webhooks';
