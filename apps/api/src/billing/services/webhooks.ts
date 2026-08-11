import Stripe from 'stripe';
import { getStripe } from '../../shared/stripe';
import { forgetWebhookEvent, recordWebhookEvent, withAccountLock } from './webhook-concurrency';
import { config } from '../../config';
import { WebhookError } from '../../errors';
import { getCreditAccount } from '../repositories/credit-accounts';
import { applyStripeSync } from './account-write-owner';
import { markTrialConverted } from './trial-admin';
import { getCustomerByStripeId, upsertCustomer } from '../repositories/customers';
import { updatePurchaseStatus, getPurchaseByPaymentIntent } from '../repositories/transactions';
import {
  getBillingPeriodByPriceId,
  getTier,
  getTierByPriceId,
  getMonthlyCredits,
  grantForSeats,
  mapRevenueCatProductToTier,
  getRevenueCatPeriodType,
  isRevenueCatAnonymous,
  isPerSeatAccount,
  resolvePerSeatPriceId,
  INCLUDED_CREDITS_PER_SEAT_USD,
  defaultAutoTopupForSeats,
} from './tiers';
import { grantCredits, resetExpiringCredits } from './credits';
import { isPayingSubscriptionStatus } from './billing-state';
import { grantMachineBonusOnce, getStripeMachineBonusKey } from './machine-bonus';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { resolveAccountId } from '../../shared/resolve-account';

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
function planKeyFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): string | undefined {
  return metadata?.plan_key || metadata?.tier_key || undefined;
}

/** Both spellings of the plan key, for writing Stripe subscription metadata. */
function planKeyMetadata(planKey: string): { tier_key: string; plan_key: string } {
  return { tier_key: planKey, plan_key: planKey };
}

export async function processStripeWebhook(rawBody: string, signature: string) {
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    throw new WebhookError(`Signature verification failed: ${(err as Error).message}`);
  }

  if (!(await recordWebhookEvent(event.id, event.type))) {
    console.log(`[Webhook] Skipping duplicate ${event.type} (${event.id})`);
    return { received: true, event_type: event.type, deduped: true };
  }

  console.log(`[Webhook] Processing ${event.type} (${event.id})`);

  try {
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
  } catch (err) {
    await forgetWebhookEvent(event.id).catch((cleanupErr) => {
      console.error(`[Webhook] Failed to clear failed event marker ${event.id}:`, cleanupErr);
    });
    throw err;
  }

  return { received: true, event_type: event.type };
}

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
    await withAccountLock(accountId, () => handleSubscriptionCheckout(session, accountId));
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
async function activateSubscriptionForAccount(params: {
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
  // trial overlay (effective-tier.ts) stops masking the purchased plan.
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
    await grantCredits(
      accountId,
      creditAmount,
      'tier_grant',
      creditDesc,
      true,
      `subscription_activation:${subscriptionId}`,
    );
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
  let perSeatDelta = 0;
  let perSeatNewSeats = 0;
  // Same gate as the tier write. Seat count, billing model, and the seat
  // allowance grant are all entitlements bought with the first invoice; an
  // `incomplete` per-seat subscription has bought none of them yet.
  if (perSeatItem && subIsPaying) {
    const newSeats = Math.max(1, Math.floor(perSeatItem.quantity ?? 1));
    const oldSeats = account?.seatCount ?? 0;
    perSeatDelta = newSeats - oldSeats;
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

  // This reset SETS expiring credit to the whole seat allowance, so it already
  // funds every seat including the ones counted in perSeatDelta. Letting the
  // delta grant below also run would stack a second full allowance on top
  // (a brand-new N-seat team would land on 2 x $25N).
  const recoveryCoveredEverySeat = shouldGrantRecoveryCredits && !!perSeatItem && recoveryCredits > 0;

  if (shouldGrantRecoveryCredits && resolvedTier) {
    if (recoveryCredits > 0) {
      await resetExpiringCredits(
        accountId,
        recoveryCredits,
        `Recovered Stripe subscription: ${recoveryCredits} credits`,
        `subscription_activation:${subscription.id}`,
      );
    }
  }

  if (perSeatItem && subIsPaying && perSeatDelta > 0 && !recoveryCoveredEverySeat) {
    // INCLUDED_CREDITS_PER_SEAT_USD ($25 of wallet allowance), never
    // PER_SEAT_PRICE_USD ($40, the price the customer pays). tiers.ts documents
    // that the two are decoupled on purpose — the other $15 is platform margin.
    // Using the price here over-granted every mid-cycle seat addition by 1.6x;
    // all 7 seat_grant rows in production history are wrong by exactly that
    // factor ($760 granted where $475 was owed).
    const seatGrant = INCLUDED_CREDITS_PER_SEAT_USD * perSeatDelta;
    await grantCredits(
      accountId,
      seatGrant,
      'seat_grant',
      `Per-seat allowance (+${perSeatDelta} ${perSeatDelta === 1 ? 'seat' : 'seats'})`,
      true,
      // Keyed on the seat count REACHED, scoped to the current billing period.
      //
      // Both halves matter, and each fixes a different real defect:
      //
      // - Period scope fixes an UNDER-grant. The old key
      //   (`${sub}:seats:${newSeats}`) had no period in it, so a team that grew
      //   to 3 seats in one month, shrank, then grew back to 3 in a LATER month
      //   reused the first month's key and was silently deduped — those seats
      //   went unfunded until the next monthly reset.
      // - Keying on the seat count reached, rather than on the `old->new`
      //   transition, bounds an OVER-grant. Seat removals never claw allowance
      //   back (there is no negative branch here on purpose), so an account that
      //   shrinks and regrows inside one period is already funded for the larger
      //   count. `4->5` and `3->5` and `2->5` are distinct transitions but the
      //   same destination: keyed on the destination, only the first one funds.
      //
      // What this still does NOT catch: a team that starts a period at N seats,
      // shrinks, then returns to N grants one extra delta, because the monthly
      // reset that funded N is not a `seat_grant` row and so never wrote this
      // key. Bounding that needs a per-period funded-seat high-water mark, which
      // is a schema change, not a key change. Tracked as follow-up.
      `${subscription.id}:seats:${subscription.current_period_start}:${perSeatNewSeats}`,
    ).catch((err) =>
      console.warn(`[Webhook] per-seat grant failed for ${accountId}:`, err),
    );
  }

  // Minting seat tokens is NOT part of the grant decision and must not be
  // nested inside it. It lived inside the `perSeatDelta > 0` block, so adding
  // the `!recoveryCoveredEverySeat` credit guard above would have silently
  // stopped minting for exactly the case this mint exists for — a brand-new
  // per-seat team, which is also the case the recovery reset covers.
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
  const billingReason = invoice.billing_reason;
  if (billingReason !== 'subscription_cycle' && billingReason !== 'subscription_create') return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const accountId = await resolveCanonicalStripeAccountId(subscription.metadata?.account_id, subscription.customer);
  if (!accountId) return;

  await repairStripeSubscriptionAccountMetadata(subscription, accountId);

  if (billingReason === 'subscription_create') {
    await activateOnFirstInvoicePaid(accountId, subscription, subscriptionId);
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

  // Per-seat accounts: credit grant scales with seat count.
  // Legacy tiers: grant the flat tier credit.
  const isPerSeatTier = tierName === 'per_seat' || account.billingModel === 'per_seat';
  const seatCount = isPerSeatTier ? Math.max(1, account.seatCount ?? 1) : 1;
  const credits = isPerSeatTier ? grantForSeats(seatCount) : getMonthlyCredits(tierName);
  const renewalDesc = isPerSeatTier
    ? `Monthly renewal: ${credits} credits (${seatCount} ${seatCount === 1 ? 'seat' : 'seats'})`
    : `Monthly renewal: ${credits} credits`;

  if (credits > 0) {
    await resetExpiringCredits(accountId, credits, renewalDesc, invoice.id);
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

export async function processRevenueCatWebhook(body: any) {
  const event = body?.event;
  if (!event) throw new WebhookError('Missing event in RevenueCat webhook');

  const eventType = event.type;
  const eventId = event.id ?? event.event_id;
  if (!eventId) throw new WebhookError('Missing event id');
  const appUserId = event.app_user_id;
  if (!appUserId) throw new WebhookError('Missing app_user_id');

  const dedupeKey = `revenuecat:${eventId}`;
  if (!(await recordWebhookEvent(dedupeKey, eventType))) {
    console.log(`[RevenueCat] Skipping duplicate ${eventType} (${eventId})`);
    return { received: true, event_type: eventType, deduped: true };
  }

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

  await applyStripeSync(
    accountId,
    {
      tier: tierKey,
      provider: 'revenuecat',
      paymentStatus: 'active',
      planType: periodType === 'yearly_commitment' ? 'yearly' : periodType,
      revenuecatProductId: productId,
      revenuecatCustomerId: event.subscriber_id ?? null,
      revenuecatSubscriptionId: event.original_transaction_id ?? event.subscriber_id ?? null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      autoTopupEnabled: true,
      autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
      autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
    },
    { account: existingAccount, reason: 'revenuecat.INITIAL_PURCHASE' },
  );

  if (tier.monthlyCredits > 0) {
    await grantCredits(
      accountId,
      tier.monthlyCredits,
      'tier_grant',
      `${tier.displayName} subscription (mobile): ${tier.monthlyCredits} credits`,
      true,
    );
  }

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

  await applyStripeSync(
    accountId,
    {
      provider: 'revenuecat',
      paymentStatus: 'active',
      lastGrantDate: new Date().toISOString(),
    },
    { account, mode: 'update', reason: 'revenuecat.RENEWAL' },
  );

  console.log(`[RevenueCat] Renewal: ${credits} credits for ${accountId}`);
}

async function handleRevenueCatCancellation(accountId: string, event: any) {
  const expirationDate = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  await applyStripeSync(
    accountId,
    {
      revenuecatCancelledAt: new Date().toISOString(),
      revenuecatCancelAtPeriodEnd: expirationDate,
      paymentStatus: event.type === 'EXPIRATION' ? 'failed' : 'active',
    },
    { mode: 'update', reason: `revenuecat.${event.type}` },
  );

  if (event.type === 'EXPIRATION') {
    await applyStripeSync(
      accountId,
      {
        tier: 'free',
        revenuecatProductId: null,
      },
      { mode: 'update', reason: 'revenuecat.EXPIRATION:revert' },
    );
  }

  console.log(`[RevenueCat] ${event.type}: ${accountId}`);
}

async function handleRevenueCatUncancellation(accountId: string, _event: any) {
  await applyStripeSync(
    accountId,
    {
      provider: 'revenuecat',
      revenuecatCancelledAt: null,
      revenuecatCancelAtPeriodEnd: null,
      paymentStatus: 'active',
    },
    { mode: 'update', reason: 'revenuecat.UNCANCELLATION' },
  );

  console.log(`[RevenueCat] Uncancellation: ${accountId}`);
}

async function handleRevenueCatProductChange(accountId: string, event: any) {
  const newProductId = event.new_product_id;
  const effectiveDate = event.effective_date
    ? new Date(event.effective_date).toISOString()
    : null;

  if (effectiveDate) {
    await applyStripeSync(
      accountId,
      {
        revenuecatPendingChangeProduct: newProductId,
        revenuecatPendingChangeDate: effectiveDate,
        revenuecatPendingChangeType: 'product_change',
      },
      { mode: 'update', reason: 'revenuecat.PRODUCT_CHANGE:pending' },
    );
  } else {
    const tierKey = mapRevenueCatProductToTier(newProductId);
    if (tierKey) {
      await applyStripeSync(
        accountId,
        {
          tier: tierKey,
          provider: 'revenuecat',
          revenuecatProductId: newProductId,
          revenuecatPendingChangeProduct: null,
          revenuecatPendingChangeDate: null,
          revenuecatPendingChangeType: null,
        },
        { mode: 'update', reason: 'revenuecat.PRODUCT_CHANGE:applied' },
      );
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
  await applyStripeSync(
    accountId,
    {
      provider: 'revenuecat',
      paymentStatus: 'past_due',
      lastPaymentFailure: new Date().toISOString(),
    },
    { mode: 'update', reason: `revenuecat.${event?.type ?? 'BILLING_ISSUE'}` },
  );

  console.log(`[RevenueCat] Billing issue: ${accountId}`);
}
