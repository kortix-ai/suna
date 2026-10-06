import Stripe from 'stripe';
import { getStripe } from '../../shared/stripe';
import { isWebhookEventProcessed, recordWebhookEvent, withAccountLock } from './webhook-concurrency';
import { config } from '../../config';
import { WebhookError } from '../../errors';
import { applyStripeSync } from './account-write-owner';
import { getCreditAccount } from '../repositories/credit-accounts';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { markTrialConverted } from './trial-admin';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { getCustomerByStripeId } from '../repositories/customers';
import { updatePurchaseStatus, getPurchaseByPaymentIntent } from '../repositories/transactions';
import { getBillingPeriodByPriceId, getTier, getTierByPriceId, getMonthlyCredits, grantForSeats, defaultAutoTopupForSeats, isPerSeatAccount, resolveRenewalGrant, resolvePerSeatPriceId } from './tiers';
import { grantForPaidProrationInvoice } from './proration-grants';
import { wallet } from '../wallet';
import { isPayingSubscriptionStatus } from './billing-state';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';
import { isUuid } from '../../shared/validate';
import { handleChargeRefunded, handleDisputeClosed, handleDisputeCreated } from './refund-clawback';
import { planKeyFromMetadata, activateSubscriptionForAccount } from './stripe-checkout-webhooks';

function planKeyMetadata(planKey: string): { tier_key: string; plan_key: string } {
  return { tier_key: planKey, plan_key: planKey };
}

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

export async function processStripeWebhook(rawBody: string, signature: string) {
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
    bindIntegrationPrincipal('stripe');
  } catch (err) {
    throw new WebhookError(`Signature verification failed: ${(err as Error).message}`);
  }

  if (await isWebhookEventProcessed(event.id)) {
    console.log(`[Webhook] Skipping duplicate ${event.type} (${event.id})`);
    return { received: true, event_type: event.type, deduped: true };
  }

  console.log(`[Webhook] Processing ${event.type} (${event.id})`);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;

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

    case 'charge.refunded':
      await handleChargeRefunded(
        event.data.object as Stripe.Charge,
        event.data.previous_attributes as Partial<Stripe.Charge> | undefined,
      );
      break;

    case 'charge.dispute.created':
      await handleDisputeCreated(event.data.object as Stripe.Dispute);
      break;

    case 'charge.dispute.closed':
      await handleDisputeClosed(event.data.object as Stripe.Dispute);
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

    const perSeatPriceId = resolvePerSeatPriceId();
    const isPerSeatActivation =
      (subscription.status === 'active' || subscription.status === 'trialing') &&
      (subscription.metadata?.billing_model === 'per_seat' ||
        subscription.items.data.some((item) => perSeatPriceId && item.price?.id === perSeatPriceId));

    const deadStatuses = ['canceled', 'unpaid', 'incomplete_expired'];
    const currentSubIsDead = deadStatuses.includes(account.stripeSubscriptionStatus ?? '')
      || account.paymentStatus === 'cancelling';
    const incomingSubIsLive = subscription.status === 'active' || subscription.status === 'trialing';
    const isOrphanedPlanRecovery =
      incomingSubIsLive &&
      currentSubIsDead &&
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
  if (perSeatItem && subIsPaying) {
    const newSeats = Math.max(1, Math.floor(perSeatItem.quantity ?? 1));
    perSeatNewSeats = newSeats;
    updates.billingModel = 'per_seat';
    updates.seatCount = newSeats;
    updates.seatSubscriptionItemId = perSeatItem.id;
    updates.tier = 'per_seat';

    if (!account?.autoTopupCustomized) {
      const defaults = defaultAutoTopupForSeats(newSeats);
      updates.autoTopupThreshold = String(defaults.threshold);
      updates.autoTopupAmount = String(defaults.amount);
    }
  }

  const trialConvertedByThisSub =
    account?.trialStatus === 'active' &&
    !!(updates.tier || perSeatItem) &&
    (subscription.status === 'active' || subscription.status === 'trialing');

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
    mode: account ? 'update' : 'upsert',
    reason: 'customer.subscription.sync',
  });

  if (trialConvertedByThisSub) {
    await markTrialConverted(accountId);
  }

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
    const restored = await tryRestoreOtherActiveSubscription(accountId, subscription, account);
    if (restored) return;
    await revertToFree(accountId, subscription.id, account);
  });
}

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

  const planSub = otherSubs.find((s) => {
    const key = planKeyFromMetadata(s.metadata);
    return !!key && key !== 'free' && !s.metadata?.server_type;
  });
  const target = planSub ?? otherSubs[0];

  console.log(
    `[Webhook] handleSubscriptionDeleted: restoring ${accountId} to other active subscription ${target.id} (tier=${planKeyFromMetadata(target.metadata) ?? 'unknown'}) instead of reverting to free`,
  );
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

async function activateOnFirstInvoicePaid(
  accountId: string,
  subscription: Stripe.Subscription,
  subscriptionId: string,
) {
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
