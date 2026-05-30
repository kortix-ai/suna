import Stripe from 'stripe';
import { stripeWebhookEventsProcessed } from '@kortix/db';
import { getStripe } from '../../shared/stripe';
import { db } from '../../shared/db';
import { config } from '../../config';
import { WebhookError } from '../../errors';
import {
  getCreditAccount,
  updateCreditAccount,
  upsertCreditAccount,
} from '../repositories/credit-accounts';
import { getCustomerByStripeId, upsertCustomer } from '../repositories/customers';
import { updatePurchaseStatus, getPurchaseByPaymentIntent } from '../repositories/transactions';
import {
  getBillingPeriodByPriceId,
  getTier,
  getTierByPriceId,
  getMonthlyCredits,
  isUpgrade,
  mapRevenueCatProductToTier,
  getRevenueCatPeriodType,
  isRevenueCatAnonymous,
  isPerSeatAccount,
  resolvePerSeatPriceId,
  PER_SEAT_PRICE_USD,
  defaultAutoTopupForSeats,
} from './tiers';
import { grantCredits, resetExpiringCredits } from './credits';
import { grantMachineBonusOnce, getStripeMachineBonusKey } from './machine-bonus';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { resolveAccountId } from '../../shared/resolve-account';

// ─── Stripe Webhook Processing ──────────────────────────────────────────────

// Simple in-memory dedup for Stripe webhook events.
export async function processStripeWebhook(rawBody: string, signature: string) {
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    throw new WebhookError(`Signature verification failed: ${(err as Error).message}`);
  }

  // DB-backed dedup: insert a marker row keyed by event.id. ON CONFLICT DO
  // NOTHING + RETURNING tells us whether we won the race. Survives restarts,
  // works across replicas. Stripe re-deliveries (CLI replay, retried delivery,
  // out-of-order retries) cannot double-apply state changes after this point.
  const inserted = await db
    .insert(stripeWebhookEventsProcessed)
    .values({ eventId: event.id, eventType: event.type })
    .onConflictDoNothing({ target: stripeWebhookEventsProcessed.eventId })
    .returning({ eventId: stripeWebhookEventsProcessed.eventId });
  if (inserted.length === 0) {
    console.log(`[Webhook] Skipping duplicate ${event.type} (${event.id})`);
    return { received: true, event_type: event.type, deduped: true };
  }

  console.log(`[Webhook] Processing ${event.type} (${event.id})`);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;

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

  return { received: true, event_type: event.type };
}

// ─── Checkout Completed ─────────────────────────────────────────────────────

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
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
    await handleSubscriptionCheckout(session, accountId);
  }
}

async function handleCreditPurchase(session: Stripe.Checkout.Session, accountId: string) {
  const amountTotal = (session.amount_total ?? 0) / 100;
  if (amountTotal <= 0) return;

  await grantCredits(
    accountId,
    amountTotal,
    'purchase',
    `Credit purchase: $${amountTotal.toFixed(2)}`,
    false,
    session.id,
  );

  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;

  if (paymentIntentId) {
    const purchase = await getPurchaseByPaymentIntent(paymentIntentId);
    if (purchase) {
      await updatePurchaseStatus(purchase.id, 'completed', new Date().toISOString());
    }
  }

  console.log(`[Webhook] Credit purchase: $${amountTotal} for ${accountId}`);
}

async function handleSubscriptionCheckout(session: Stripe.Checkout.Session, accountId: string) {
  const tierKey = session.metadata?.tier_key;
  if (!tierKey) return;

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;
  if (!subscriptionId) return;

  const tier = getTier(tierKey);
  const commitmentType = session.metadata?.commitment_type;
  const isYearly = commitmentType === 'yearly' || commitmentType === 'yearly_commitment';
  const existingAccount = await getCreditAccount(accountId);
  const previousSubscriptionId = session.metadata?.previous_subscription_id
    ?? (
      existingAccount?.tier === 'free' &&
      existingAccount.stripeSubscriptionId &&
      existingAccount.stripeSubscriptionId !== subscriptionId
        ? existingAccount.stripeSubscriptionId
        : null
    );

  // Ensure credit account exists (for credits system — separate from instance billing).
  // Use the latest subscription ID so account-state reflects a paid tier.
  await upsertCreditAccount(accountId, {
    tier: tierKey,
    provider: 'stripe',
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: 'active',
    planType: isYearly ? 'yearly' : 'monthly',
    commitmentType: commitmentType === 'yearly_commitment' ? commitmentType : null,
    ...(isYearly ? { nextCreditGrant: calculateNextCreditGrant(new Date()).toISOString() } : {}),
    // Auto-topup on by default: charge $5 when balance drops below $1
    autoTopupEnabled: true,
    autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
    autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
  });

  // Grant tier credits if applicable (credits system, separate from instances)
  if (tier.monthlyCredits > 0) {
    await grantCredits(
      accountId,
      tier.monthlyCredits,
      'tier_grant',
      `${tier.displayName} subscription activated: ${tier.monthlyCredits} credits`,
      true,
      session.id,
    );
  }

  // Upsert Stripe customer record
  if (session.customer) {
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
    await upsertCustomer({
      accountId,
      id: customerId,
      email: session.customer_email ?? null,
      provider: 'stripe',
      active: true,
    });
  }

  if (previousSubscriptionId && previousSubscriptionId !== subscriptionId) {
    await cancelFreeSubscriptionForUpgrade(previousSubscriptionId, accountId);
  }

  // ── Provision instance (1 subscription = 1 instance) ───────────────────
  // The checkout metadata carries server_type + location for provisioning.
  const serverType = session.metadata?.server_type;
  const location = session.metadata?.location;

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

    // Legacy auto-provision of a per-account sandbox on checkout-completed
    // has been removed — sandboxes are now per-session under /v1/projects.
    void serverType;
    void location;
    void tierKey;
  }

  console.log(`[Webhook] Subscription checkout: ${tierKey} for ${accountId} (sub=${subscriptionId})`);
}

async function handleSubscriptionChange(subscription: Stripe.Subscription) {
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) {
    console.warn('[Webhook] subscription change: no canonical account_id');
    return;
  }

  await repairStripeSubscriptionAccountMetadata(subscription, accountId);
  await syncSubscriptionState(accountId, subscription);
}

async function syncSubscriptionState(accountId: string, subscription: Stripe.Subscription) {
  const account = await getCreditAccount(accountId);
  if (account?.stripeSubscriptionId && account.stripeSubscriptionId !== subscription.id) {
    const previousSubId = subscription.metadata?.previous_subscription_id;
    const currentTier = account.tier ?? 'free';
    const incomingTier = subscription.metadata?.tier_key;
    const isFreeUpgrade =
      currentTier === 'free' &&
      incomingTier &&
      incomingTier !== 'free' &&
      subscription.status === 'active' &&
      previousSubId === account.stripeSubscriptionId;

    if (isFreeUpgrade) {
      console.log(
        `[Webhook] syncSubscriptionState: detected free→${incomingTier} upgrade for ${accountId}, cancelling old free sub ${account.stripeSubscriptionId}`,
      );
      await cancelFreeSubscriptionForUpgrade(account.stripeSubscriptionId, accountId);
    } else {
      console.log(`[Webhook] syncSubscriptionState: skipping stale subscription ${subscription.id} for ${accountId} (current: ${account.stripeSubscriptionId})`);
      return;
    }
  }

  const tierKey = subscription.metadata?.tier_key;
  const priceId = subscription.items.data[0]?.price?.id;
  const resolvedTier = tierKey ?? getTierByPriceId(priceId ?? '')?.name ?? null;
  const billingPeriod = getBillingPeriodByPriceId(priceId ?? '') ?? (subscription.metadata?.commitment_type as any) ?? 'monthly';
  const shouldGrantRecoveryCredits =
    !!resolvedTier &&
    (!account || (!account.stripeSubscriptionId && (!account.tier || account.tier === 'free' || account.tier === 'none')));

  console.log(`[Webhook] syncSubscriptionState: account=${accountId} tier_meta=${tierKey} price=${priceId} resolved=${resolvedTier} status=${subscription.status}`);

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

  if (resolvedTier) {
    updates.tier = resolvedTier;
  }

  if (subscription.cancel_at_period_end) {
    updates.paymentStatus = 'cancelling';
  } else if (subscription.status === 'active') {
    updates.paymentStatus = 'active';
  }

  // Billing v2 — if this subscription has a per-seat item, reconcile quantity
  // and grant additional seat credits for net additions. Identified by the
  // per-seat price ID on any item (also accepts metadata.billing_model='per_seat'
  // as a hint during the cutover before price IDs are wired up).
  const perSeatPriceId = resolvePerSeatPriceId();
  const perSeatItem = subscription.items.data.find(
    (item) =>
      (perSeatPriceId && item.price?.id === perSeatPriceId) ||
      subscription.metadata?.billing_model === 'per_seat',
  );
  let perSeatDelta = 0;
  if (perSeatItem) {
    const newSeats = Math.max(1, Math.floor(perSeatItem.quantity ?? 1));
    const oldSeats = account?.seatCount ?? 0;
    perSeatDelta = newSeats - oldSeats;
    updates.billingModel = 'per_seat';
    updates.seatCount = newSeats;
    updates.seatSubscriptionItemId = perSeatItem.id;
    updates.tier = 'per_seat';

    // Apply scaled auto-topup defaults if the user hasn't customised them.
    if (!account?.autoTopupCustomized) {
      const defaults = defaultAutoTopupForSeats(newSeats);
      updates.autoTopupThreshold = String(defaults.threshold);
      updates.autoTopupAmount = String(defaults.amount);
    }
  }

  if (!account) {
    await upsertCreditAccount(accountId, updates);
  } else {
    await updateCreditAccount(accountId, updates);
  }

  if (shouldGrantRecoveryCredits && resolvedTier) {
    const credits = getMonthlyCredits(resolvedTier);
    if (credits > 0) {
      await resetExpiringCredits(
        accountId,
        credits,
        `Recovered Stripe subscription: ${credits} credits`,
        `legacy_sync:${subscription.id}`,
      );
    }
  }

  // Per-seat included credit grant. Stripe handles the dollar proration on
  // the invoice; we mirror that in the wallet so the new seat can spend
  // immediately rather than waiting for the next bill cycle.
  //
  // Wallet is fungible — $40/seat goes into one bucket. The compute-vs-LLM
  // split is a pricing-page message, not a wallet partition. Spend
  // attribution happens at the ledger entry level (compute_debit / llm_debit).
  if (perSeatItem && perSeatDelta > 0) {
    const seatGrant = PER_SEAT_PRICE_USD * perSeatDelta;
    await grantCredits(
      accountId,
      seatGrant,
      'seat_grant',
      `Per-seat allowance (+${perSeatDelta} ${perSeatDelta === 1 ? 'seat' : 'seats'})`,
      true,
      `${subscription.id}:seats:${updates.seatCount}`,
    ).catch((err) =>
      console.warn(`[Webhook] per-seat grant failed for ${accountId}:`, err),
    );

    // First-time transition: account just flipped from legacy/free to per_seat.
    // Mint YOLO tokens for every existing member who doesn't have one (owner
    // + any pre-subscription joiners). Idempotent on subsequent webhook fires.
    if (perSeatItem && !isPerSeatAccount(account?.billingModel)) {
      const { mintYoloTokensForAllMembers } = await import('./seat-management');
      void mintYoloTokensForAllMembers(accountId).catch((err) =>
        console.warn(`[Webhook] mint YOLO tokens for existing members failed for ${accountId}:`, err),
      );
    }
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) return;

  const account = await getCreditAccount(accountId);
  if (account?.stripeSubscriptionId && account.stripeSubscriptionId !== subscription.id) {
    console.log(
      `[Webhook] handleSubscriptionDeleted: skipping stale subscription ${subscription.id} for ${accountId} (current: ${account.stripeSubscriptionId})`,
    );
    return;
  }

  await revertToFree(accountId, subscription.id);
}

async function revertToFree(accountId: string, subscriptionId?: string) {
  // Legacy sandbox archive/sub-coupling has been removed — session sandboxes
  // are per-session and not tied to a Stripe subscription. We just revert
  // the account's tier on cancellation.
  void subscriptionId;

  await updateCreditAccount(accountId, {
    tier: 'free',
    stripeSubscriptionStatus: 'canceled',
    scheduledTierChange: null,
    scheduledTierChangeDate: null,
    scheduledPriceId: null,
    commitmentType: null,
    commitmentEndDate: null,
    paymentStatus: 'active',
  });
  console.log(`[Webhook] Reverted to free tier: ${accountId}`);
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id;
  if (!subscriptionId) return;

  const billingReason = invoice.billing_reason;
  if (billingReason !== 'subscription_cycle') return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) return;

  await repairStripeSubscriptionAccountMetadata(subscription, accountId);

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
  const credits = getMonthlyCredits(tierName);

  if (credits > 0) {
    await resetExpiringCredits(accountId, credits, `Monthly renewal: ${credits} credits`, invoice.id);
  }

  const planType = account.planType ?? 'monthly';
  const nextCreditGrant = planType === 'yearly'
    ? calculateNextCreditGrant(new Date()).toISOString()
    : new Date(subscription.current_period_end * 1000).toISOString();

  await updateCreditAccount(accountId, {
    lastRenewalPeriodStart: periodStart,
    lastProcessedInvoiceId: invoice.id,
    lastGrantDate: new Date().toISOString(),
    nextCreditGrant,
  });

  console.log(`[Webhook] Renewal processed: ${credits} credits for ${accountId}`);
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
          metadata: { ...subscription.metadata, tier_key: targetTier, downgrade: '', target_tier: '' },
        });
        console.log(`[Webhook] Price already correct (schedule applied), updated metadata for ${accountId}`);
      } else {
        await stripe.subscriptions.update(account.stripeSubscriptionId, {
          items: [{ id: subscription.items.data[0].id, price: account.scheduledPriceId }],
          proration_behavior: 'none',
          metadata: { ...subscription.metadata, tier_key: targetTier, downgrade: '', target_tier: '' },
        });
        console.log(`[Webhook] Stripe price updated to ${account.scheduledPriceId} for ${accountId}`);
      }
    } catch (err) {
      console.error(`[Webhook] Failed to update Stripe subscription for ${accountId}:`, err);
    }
  }

  await updateCreditAccount(accountId, {
    tier: targetTier,
    scheduledTierChange: null,
    scheduledTierChangeDate: null,
    scheduledPriceId: null,
  });

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

    await updateCreditAccount(accountId, {
      tier: targetTier,
      scheduledTierChange: null,
      scheduledTierChangeDate: null,
      scheduledPriceId: null,
    });

    const subscriptionId = typeof schedule.subscription === 'string'
      ? schedule.subscription
      : schedule.subscription?.id;

    if (subscriptionId) {
      const stripe = getStripe();
      try {
        await stripe.subscriptions.update(subscriptionId, {
          metadata: { tier_key: targetTier, downgrade: '', target_tier: '', scheduled_change: '' },
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

  await updateCreditAccount(accountId, {
    paymentStatus: 'past_due',
    lastPaymentFailure: new Date().toISOString(),
  });

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

export async function processRevenueCatWebhook(body: any) {
  const event = body?.event;
  if (!event) throw new WebhookError('Missing event in RevenueCat webhook');

  const eventType = event.type;
  const appUserId = event.app_user_id;
  if (!appUserId) throw new WebhookError('Missing app_user_id');

  if (isRevenueCatAnonymous(appUserId)) {
    console.log(`[RevenueCat] Skipping anonymous user: ${appUserId}`);
    return { received: true, event_type: eventType, skipped: true };
  }

  const accountId = await resolveAccountId(appUserId);

  console.log(`[RevenueCat] Processing ${eventType} for ${appUserId} -> ${accountId}`);

  switch (eventType) {
    case 'INITIAL_PURCHASE':
      await handleRevenueCatPurchase(accountId, event);
      break;

    case 'RENEWAL':
      await handleRevenueCatRenewal(accountId, event);
      break;

    case 'CANCELLATION':
    case 'EXPIRATION':
      await handleRevenueCatCancellation(accountId, event);
      break;

    case 'UNCANCELLATION':
      await handleRevenueCatUncancellation(accountId, event);
      break;

    case 'PRODUCT_CHANGE':
      await handleRevenueCatProductChange(accountId, event);
      break;

    case 'NON_RENEWING_PURCHASE':
      await handleRevenueCatTopup(accountId, event);
      break;

    case 'SUBSCRIPTION_PAUSED':
    case 'BILLING_ISSUE':
      await handleRevenueCatBillingIssue(accountId, event);
      break;

    default:
      console.log(`[RevenueCat] Unhandled event type: ${eventType}`);
  }

  return { received: true, event_type: eventType, account_id: accountId };
}

async function handleRevenueCatPurchase(accountId: string, event: any) {
  const productId = event.product_id;
  const tierKey = mapRevenueCatProductToTier(productId);
  if (!tierKey) {
    console.warn(`[RevenueCat] Unknown product ID: ${productId}`);
    return;
  }

  const tier = getTier(tierKey);
  const periodType = getRevenueCatPeriodType(productId);

  const existingAccount = await getCreditAccount(accountId);
  const oldStripeSubscriptionId = existingAccount?.stripeSubscriptionId ?? null;

  await upsertCreditAccount(accountId, {
    tier: tierKey,
    provider: 'revenuecat',
    paymentStatus: 'active',
    planType: periodType === 'yearly_commitment' ? 'yearly' : periodType,
    revenuecatProductId: productId,
    revenuecatCustomerId: event.subscriber_id ?? null,
    revenuecatSubscriptionId: event.original_transaction_id ?? event.subscriber_id ?? null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    // Auto-topup on by default: charge $5 when balance drops below $1
    autoTopupEnabled: true,
    autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
    autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
  });

  if (tier.monthlyCredits > 0) {
    await grantCredits(
      accountId,
      tier.monthlyCredits,
      'tier_grant',
      `${tier.displayName} subscription (mobile): ${tier.monthlyCredits} credits`,
      true,
    );
  }

  // Grant one-time $5 machine credit bonus (non-expiring, idempotent per purchase)
  const { MACHINE_CREDIT_BONUS } = await import('./tiers');
  if (MACHINE_CREDIT_BONUS > 0) {
    try {
      await grantCredits(
        accountId,
        MACHINE_CREDIT_BONUS,
        'machine_bonus',
        `Welcome credit bonus: $${MACHINE_CREDIT_BONUS}`,
        false,
        `machine_bonus:revenuecat:${accountId}:${productId}`,
      );
      console.log(`[RevenueCat] Granted $${MACHINE_CREDIT_BONUS} machine bonus for ${accountId}`);
    } catch (err) {
      console.error(`[RevenueCat] Failed to grant machine bonus for ${accountId}:`, err);
    }
  }

  if (oldStripeSubscriptionId) {
    await cancelFreeSubscriptionForUpgrade(oldStripeSubscriptionId, accountId);
  }

  console.log(`[RevenueCat] Initial purchase: ${tierKey} for ${accountId}`);
}

async function handleRevenueCatRenewal(accountId: string, event: any) {
  const account = await getCreditAccount(accountId);
  if (!account) return;

  const tierName = account.tier ?? 'free';
  const credits = getMonthlyCredits(tierName);

  if (credits > 0) {
    await resetExpiringCredits(accountId, credits, `Mobile renewal: ${credits} credits`);
  }

  await updateCreditAccount(accountId, {
    provider: 'revenuecat',
    paymentStatus: 'active',
    lastGrantDate: new Date().toISOString(),
  });

  console.log(`[RevenueCat] Renewal: ${credits} credits for ${accountId}`);
}

async function handleRevenueCatCancellation(accountId: string, event: any) {
  const expirationDate = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  await updateCreditAccount(accountId, {
    revenuecatCancelledAt: new Date().toISOString(),
    revenuecatCancelAtPeriodEnd: expirationDate,
    paymentStatus: event.type === 'EXPIRATION' ? 'failed' : 'active',
  });

  if (event.type === 'EXPIRATION') {
    await updateCreditAccount(accountId, {
      tier: 'free',
      revenuecatProductId: null,
    });
  }

  console.log(`[RevenueCat] ${event.type}: ${accountId}`);
}

async function handleRevenueCatUncancellation(accountId: string, _event: any) {
  await updateCreditAccount(accountId, {
    provider: 'revenuecat',
    revenuecatCancelledAt: null,
    revenuecatCancelAtPeriodEnd: null,
    paymentStatus: 'active',
  });

  console.log(`[RevenueCat] Uncancellation: ${accountId}`);
}

async function handleRevenueCatProductChange(accountId: string, event: any) {
  const newProductId = event.new_product_id;
  const effectiveDate = event.effective_date
    ? new Date(event.effective_date).toISOString()
    : null;

  if (effectiveDate) {
    await updateCreditAccount(accountId, {
      revenuecatPendingChangeProduct: newProductId,
      revenuecatPendingChangeDate: effectiveDate,
      revenuecatPendingChangeType: 'product_change',
    });
  } else {
    const tierKey = mapRevenueCatProductToTier(newProductId);
    if (tierKey) {
      await updateCreditAccount(accountId, {
        tier: tierKey,
        provider: 'revenuecat',
        revenuecatProductId: newProductId,
        revenuecatPendingChangeProduct: null,
        revenuecatPendingChangeDate: null,
        revenuecatPendingChangeType: null,
      });
    }
  }

  console.log(`[RevenueCat] Product change: ${accountId}`);
}

async function handleRevenueCatTopup(accountId: string, event: any) {
  const price = event.price ? Number(event.price) : 0;
  if (price <= 0) return;

  await grantCredits(
    accountId,
    price,
    'purchase',
    `Mobile credit purchase: $${price.toFixed(2)}`,
    false,
  );

  console.log(`[RevenueCat] Top-up: $${price} for ${accountId}`);
}

async function handleRevenueCatBillingIssue(accountId: string, event: any) {
  await updateCreditAccount(accountId, {
    provider: 'revenuecat',
    paymentStatus: 'past_due',
    lastPaymentFailure: new Date().toISOString(),
  });

  console.log(`[RevenueCat] Billing issue: ${accountId}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function calculateNextCreditGrant(from: Date): Date {
  const next = new Date(from);
  const targetMonth = (next.getMonth() + 1) % 12;
  const targetYear = next.getFullYear() + (next.getMonth() === 11 ? 1 : 0);
  next.setMonth(next.getMonth() + 1);
  // Handle month boundary (e.g., Jan 31 → Feb 28): if month overflowed, set to last day of target month
  if (next.getMonth() !== targetMonth) {
    next.setDate(0);
  }
  return next;
}
