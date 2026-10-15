import { createHostedCheckout } from './hosted-checkout';
import { getStripe } from '../../shared/stripe';
import {
  getCreditAccount,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { getCustomerByAccountId, upsertCustomer, deleteCustomerByStripeId } from '../repositories/customers';
import { BillingError, SubscriptionError } from '../../errors';
import {
  PLAN_MAX_MONTHLY_USD,
  PLAN_MIN_MONTHLY_USD,
  monthlyCreditsForSubscription,
  planForSubscription,
  resolveCreditsPriceId,
} from './tiers';
import { isDeadSubscriptionStatus } from './billing-state';
import { applyStripeSync } from './account-write-owner';
import { grantForPaidProrationInvoice } from './proration-grants';
import Stripe from 'stripe';

/**
 * True for Stripe's "No such <object>" (resource_missing): the id does not
 * exist in the CURRENT Stripe account — a stale mapping, a repointed key, or
 * arbitrary client input. An expected state, never a 500.
 */
function isStripeNoSuchResource(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string; raw?: { code?: string }; message?: string };
  return e?.statusCode === 404
    || e?.code === 'resource_missing'
    || e?.raw?.code === 'resource_missing'
    || /no such (customer|checkout\.session)/i.test(e?.message ?? '');
}

/**
 * The account's Stripe customer id — but ONLY if it still exists in the CURRENT
 * Stripe account. The env key can point at a different account than the one the
 * id was created in (e.g. after the key is repointed), leaving a stale id that
 * 500s every downstream call ("No such customer"). On a missing customer we drop
 * the stale mapping and return null so callers can recreate (checkout) or skip
 * (read-only paths). Only a non-missing (transient) Stripe error throws.
 */
export async function resolveLiveStripeCustomerId(accountId: string): Promise<string | null> {
  const existing = await getCustomerByAccountId(accountId);
  if (!existing) return null;
  try {
    const cust = await getStripe().customers.retrieve(existing.id);
    if (!('deleted' in cust) || !cust.deleted) return existing.id;
  } catch (err) {
    if (!isStripeNoSuchResource(err)) throw err;
  }
  console.warn(
    `[billing] Stripe customer ${existing.id} for ${accountId} not found in the current Stripe account; dropping stale mapping`,
  );
  await deleteCustomerByStripeId(existing.id);
  return null;
}

export async function getOrCreateStripeCustomer(
  accountId: string,
  email: string,
): Promise<string> {
  const live = await resolveLiveStripeCustomerId(accountId);
  if (live) return live;

  const customer = await getStripe().customers.create({
    email,
    metadata: { account_id: accountId },
  });

  await upsertCustomer({
    accountId,
    id: customer.id,
    email,
    provider: 'stripe',
    active: true,
  });

  return customer.id;
}

/** Parse and bound a requested monthly amount. Whole dollars only. */
export function parseMonthlyUsd(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < PLAN_MIN_MONTHLY_USD || n > PLAN_MAX_MONTHLY_USD) {
    throw new BillingError(
      `monthly_usd must be a whole number from ${PLAN_MIN_MONTHLY_USD} to ${PLAN_MAX_MONTHLY_USD}`,
      400,
    );
  }
  return n;
}

/**
 * THE plan change: put the account on the credits plan at `monthlyUsd` a month.
 *
 * - No live paid subscription → hosted Stripe Checkout. Activation is
 *   webhook-driven (`invoice.paid` / `checkout.session.completed`).
 * - Live subscription already on the credits price. The amount IN EFFECT is
 *   `plan_monthly_usd`; the Stripe quantity is what the next renewal bills.
 *   - A raise (above the amount in effect) is instant: charged now, prorated
 *     (`always_invoice`), and applied only once paid. The paid proration
 *     invoice grants its net amount at once.
 *   - A cut is scheduled: Stripe bills the new amount from the next renewal
 *     (no proration, no refund), `scheduled_monthly_usd` records it, and the
 *     renewal applies it. The current period keeps its amount and its credits.
 *   - The amount in effect again cancels a scheduled cut ("keep").
 * - Live subscription on any legacy price (per-seat, a tier, yearly) → replace
 *   its items with the credits price, prorated, so unused legacy time is
 *   credited by Stripe.
 */
export async function setPlan(params: {
  accountId: string;
  email: string;
  monthlyUsd: number;
  successUrl: string;
  cancelUrl: string;
  locale?: string;
}) {
  const { accountId, email, monthlyUsd, successUrl, cancelUrl, locale } = params;
  const priceId = resolveCreditsPriceId();
  const quantity = monthlyUsd * 100;
  const account = await getCreditAccount(accountId);
  const stripe = getStripe();

  const live = account?.stripeSubscriptionId
    ? await stripe.subscriptions.retrieve(account.stripeSubscriptionId).catch(() => null)
    : null;
  const livePaid = live && !isDeadSubscriptionStatus(live.status) && planForSubscription(live) === 'credits'
    ? live
    : null;

  if (!livePaid) {
    const customerId = await getOrCreateStripeCustomer(accountId, email);
    const metadata: Record<string, string> = {
      account_id: accountId,
      tier_key: 'credits',
      plan_key: 'credits',
      ...(live && account?.tier === 'free' ? { previous_subscription_id: live.id } : {}),
    };
    const session = await createHostedCheckout(stripe, {
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      payment_method_collection: 'always',
      subscription_data: { metadata },
      metadata,
      ...(locale ? { locale: locale as Stripe.Checkout.SessionCreateParams.Locale } : {}),
    });
    return { status: 'checkout_created' as const, checkout_url: session.url, monthly_usd: monthlyUsd };
  }

  if (account?.commitmentType === 'yearly_commitment' && account.commitmentEndDate
    && new Date(account.commitmentEndDate) > new Date()) {
    throw new SubscriptionError('Your yearly commitment has not ended yet');
  }

  const billedUsd = monthlyCreditsForSubscription(livePaid);
  const onCreditsPrice = livePaid.items.data.length === 1 && livePaid.items.data[0].price?.id === priceId;
  const inEffectUsd = onCreditsPrice ? inEffectMonthlyUsd(account, billedUsd) : billedUsd;
  const metadata = { ...livePaid.metadata, tier_key: 'credits', plan_key: 'credits' };
  const effectiveAt = new Date(livePaid.current_period_end * 1000).toISOString();

  if (onCreditsPrice && monthlyUsd <= inEffectUsd) {
    if (monthlyUsd === inEffectUsd && billedUsd === inEffectUsd) {
      return { status: 'unchanged' as const, change: 'none' as const, monthly_usd: monthlyUsd };
    }
    // A cut, or "keep" (back to the amount in effect). No money moves now:
    // Stripe bills `quantity` from the next renewal.
    await stripe.subscriptions.update(livePaid.id, {
      items: [{ id: livePaid.items.data[0].id, quantity }],
      proration_behavior: 'none',
      metadata,
    });
    const kept = monthlyUsd === inEffectUsd;
    // planMonthlyUsd is written too: the subscription.updated webhook may land
    // first and record the billed amount; this write restores the one in effect.
    await applyStripeSync(
      accountId,
      {
        tier: 'credits',
        planMonthlyUsd: String(inEffectUsd),
        scheduledMonthlyUsd: kept ? null : String(monthlyUsd),
        scheduledTierChangeDate: kept ? null : effectiveAt,
      },
      { mode: 'update', reason: kept ? 'set-plan:keep' : 'set-plan:cut' },
    );
    return kept
      ? { status: 'updated' as const, change: 'kept' as const, monthly_usd: monthlyUsd }
      : { status: 'updated' as const, change: 'scheduled' as const, monthly_usd: monthlyUsd, effective_at: effectiveAt };
  }

  // A raise. A scheduled cut is undone first, without proration, so the
  // prorated charge runs from the amount this period was paid at.
  if (onCreditsPrice && billedUsd !== inEffectUsd) {
    await stripe.subscriptions.update(livePaid.id, {
      items: [{ id: livePaid.items.data[0].id, quantity: inEffectUsd * 100 }],
      proration_behavior: 'none',
    });
  }

  const updated = await stripe.subscriptions.update(livePaid.id, {
    items: onCreditsPrice
      ? [{ id: livePaid.items.data[0].id, quantity }]
      : [...livePaid.items.data.map((item) => ({ id: item.id, deleted: true })), { price: priceId, quantity }],
    proration_behavior: 'always_invoice',
    // A raise applies ONLY if its charge succeeds; on a failed payment Stripe
    // keeps the old items and returns a `pending_update` instead of throwing.
    payment_behavior: 'pending_if_incomplete',
    expand: ['latest_invoice.payment_intent'],
    metadata,
  });

  const invoice = typeof updated.latest_invoice === 'object' ? updated.latest_invoice : null;
  if (updated.pending_update || !invoice || invoice.status !== 'paid') {
    // Nothing is written: `customer.subscription.updated` writes the amount
    // once the pending update applies, and `invoice.paid` grants the credits.
    const paymentIntent = invoice && typeof invoice.payment_intent === 'object' ? invoice.payment_intent : null;
    return {
      status: 'payment_pending' as const,
      monthly_usd: monthlyUsd,
      client_secret: paymentIntent?.client_secret ?? null,
    };
  }

  // Paid now. Mirror the state early for the UI; the webhooks converge on the
  // same amount and the same invoice-keyed grant.
  await applyStripeSync(
    accountId,
    { tier: 'credits', planMonthlyUsd: String(monthlyUsd), scheduledMonthlyUsd: null, scheduledTierChangeDate: null },
    { mode: 'update', reason: 'set-plan:raise' },
  );
  const grant = await grantForPaidProrationInvoice(accountId, invoice);
  return {
    status: 'updated' as const,
    change: 'raised' as const,
    monthly_usd: monthlyUsd,
    charged_usd: (invoice.amount_paid ?? 0) / 100,
    credits_added: grant.kind === 'raise' ? grant.netCents : 0,
  };
}

/**
 * What `setPlan(monthlyUsd)` would do, without doing it: the change, the
 * charge due now and the credits added now (1 credit = $0.01). A raise is
 * priced from Stripe's own proration preview, so coupons and the exact period
 * length count; `credits_now` sums the same proration lines the grant sums.
 */
export async function previewPlan(params: { accountId: string; monthlyUsd: number }) {
  const { accountId, monthlyUsd } = params;
  const priceId = resolveCreditsPriceId();
  const account = await getCreditAccount(accountId);
  const stripe = getStripe();
  const live = account?.stripeSubscriptionId
    ? await stripe.subscriptions.retrieve(account.stripeSubscriptionId).catch(() => null)
    : null;
  const livePaid = live && !isDeadSubscriptionStatus(live.status) && planForSubscription(live) === 'credits'
    ? live
    : null;
  if (!livePaid) {
    return { change: 'checkout' as const, monthly_usd: monthlyUsd, current_monthly_usd: null, due_now_usd: monthlyUsd, credits_now: monthlyUsd * 100, effective_at: null };
  }

  const billedUsd = monthlyCreditsForSubscription(livePaid);
  const onCreditsPrice = livePaid.items.data.length === 1 && livePaid.items.data[0].price?.id === priceId;
  const inEffectUsd = onCreditsPrice ? inEffectMonthlyUsd(account, billedUsd) : billedUsd;
  const renewsAt = new Date(livePaid.current_period_end * 1000).toISOString();
  const base = { monthly_usd: monthlyUsd, current_monthly_usd: inEffectUsd };

  if (onCreditsPrice && monthlyUsd <= inEffectUsd) {
    const change = monthlyUsd < inEffectUsd ? 'scheduled' : billedUsd === inEffectUsd ? 'none' : 'kept';
    return { ...base, change, due_now_usd: 0, credits_now: 0, effective_at: change === 'scheduled' ? renewsAt : null };
  }

  const upcoming = await stripe.invoices.retrieveUpcoming({
    customer: typeof livePaid.customer === 'string' ? livePaid.customer : livePaid.customer.id,
    subscription: livePaid.id,
    subscription_items: onCreditsPrice
      ? [{ id: livePaid.items.data[0].id, quantity: monthlyUsd * 100 }]
      : [...livePaid.items.data.map((item) => ({ id: item.id, deleted: true })), { price: priceId, quantity: monthlyUsd * 100 }],
    subscription_proration_behavior: 'always_invoice',
    subscription_proration_date: Math.floor(Date.now() / 1000),
  });
  const prorationCents = upcoming.lines.data
    .filter((line) => line.proration)
    .reduce((sum, line) => sum + line.amount, 0);
  // Stripe prices the raise from the billed quantity. With a cut scheduled,
  // setPlan raises from the amount in effect instead; proration is linear in
  // the quantity change, so scale to it.
  const cents = onCreditsPrice && billedUsd !== inEffectUsd
    ? Math.round((prorationCents * (monthlyUsd - inEffectUsd)) / (monthlyUsd - billedUsd))
    : prorationCents;
  const netCents = Math.max(0, cents);
  return { ...base, change: 'raised' as const, due_now_usd: netCents / 100, credits_now: netCents, effective_at: null };
}

/**
 * The monthly amount in effect THIS period: the stored `plan_monthly_usd`
 * while a cut waits for the renewal, else what Stripe bills.
 */
export function inEffectMonthlyUsd(
  account: { planMonthlyUsd?: string | number | null; scheduledMonthlyUsd?: string | number | null } | null | undefined,
  billedUsd: number,
): number {
  const stored = Number(account?.planMonthlyUsd);
  return account?.scheduledMonthlyUsd != null && Number.isFinite(stored) && stored > 0 ? stored : billedUsd;
}

export async function createPortalSession(accountId: string, returnUrl: string, email?: string) {
  // Verify the stored customer exists in the current Stripe account (drops a
  // stale id); recreate it if missing so the portal never 500s on "No such customer".
  let customerId = await resolveLiveStripeCustomerId(accountId);
  if (!customerId) {
    if (!email) throw new BillingError('No billing customer found');
    customerId = await getOrCreateStripeCustomer(accountId, email);
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return { portal_url: session.url };
}

export async function cancelSubscription(accountId: string, feedback?: string) {
  const account = await getCreditAccount(accountId);
  if (!account?.stripeSubscriptionId) throw new SubscriptionError('No active subscription');

  if (account.commitmentType && account.commitmentEndDate) {
    const commitmentEnd = new Date(account.commitmentEndDate);
    if (commitmentEnd > new Date()) {
      throw new SubscriptionError('Cannot cancel during commitment period');
    }
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.update(account.stripeSubscriptionId, {
    cancel_at_period_end: true,
    metadata: { cancellation_feedback: feedback ?? '' },
  });

  // Mirror what the customer.subscription.updated webhook will write, so the
  // account state — and the pending-cancellation control that reads it —
  // flips on the refetch the client fires right after this call, without
  // waiting on webhook latency. The webhook later reconciles the same value.
  await applyStripeSync(
    accountId,
    { paymentStatus: 'cancelling' },
    { mode: 'update', reason: 'cancel-subscription' },
  );

  return {
    success: true,
    cancel_at: subscription.cancel_at,
    message: 'Subscription will cancel at end of billing period',
  };
}

export async function reactivateSubscription(accountId: string) {
  const account = await getCreditAccount(accountId);
  if (!account?.stripeSubscriptionId) throw new SubscriptionError('No subscription to reactivate');

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.update(account.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });

  // Same mirror as cancelSubscription, bounded the same way the
  // customer.subscription.updated webhook writes it: only an ACTIVE status
  // clears the pending-cancellation flag, so a reactivation on a past-due
  // subscription cannot mask the failed-payment state (the next webhook
  // event reconciles it).
  if (subscription.status === 'active') {
    await applyStripeSync(
      accountId,
      { paymentStatus: 'active' },
      { mode: 'update', reason: 'reactivate-subscription' },
    );
  }

  return { success: true, message: 'Subscription reactivated' };
}

export async function syncSubscription(accountId: string) {
  let account = await getCreditAccount(accountId);
  if (!account?.stripeSubscriptionId) {
    const { syncLegacyStripeSubscription } = await import('./legacy-stripe-sync');
    const reconciliation = await syncLegacyStripeSubscription(accountId);
    if (reconciliation.status === 'error') {
      throw new BillingError(reconciliation.error ?? 'Legacy subscription sync failed');
    }

    account = await getCreditAccount(accountId);
    if (!account?.stripeSubscriptionId) {
      return {
        success: true,
        message: reconciliation.status === 'no_active_paid_subscription'
          ? 'No active paid subscription found to sync'
          : 'No subscription to sync',
      };
    }
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);

  await updateCreditAccount(accountId, {
    stripeSubscriptionStatus: subscription.status,
    billingCycleAnchor: new Date(subscription.billing_cycle_anchor * 1000).toISOString(),
  });

  return { success: true, message: 'Subscription synced' };
}

/**
 * Retrieve a checkout session by a CLIENT-SUPPLIED id. The id can be stale,
 * belong to a different Stripe account (the key was repointed), or be
 * arbitrary input; Stripe then answers `resource_missing`
 * ("No such checkout.session"), which used to fall through the typed-error
 * ladder to the generic 500 + Sentry path. Map it to the 404 the routes
 * already declare. Only a non-missing (transient) Stripe error rethrows.
 */
async function retrieveCheckoutSession(sessionId: string, expand: string[]) {
  try {
    return await getStripe().checkout.sessions.retrieve(sessionId, { expand });
  } catch (err) {
    if (!isStripeNoSuchResource(err)) throw err;
    throw new BillingError('Checkout session not found', 404);
  }
}

export async function getCheckoutSessionDetails(accountId: string, sessionId: string) {
  const session = await retrieveCheckoutSession(sessionId, ['total_details.breakdown']);

  const sessionAccountId = session.metadata?.account_id;
  if (!sessionAccountId || sessionAccountId !== accountId) {
    throw new BillingError('Checkout session does not belong to this account', 404);
  }

  const discount = session.total_details?.breakdown?.discounts?.[0];

  return {
    session_id: session.id,
    amount_total: session.amount_total ?? 0,
    amount_subtotal: session.amount_subtotal ?? 0,
    amount_discount: discount?.amount ?? 0,
    amount_tax: session.total_details?.amount_tax ?? 0,
    currency: session.currency ?? 'usd',
    coupon_id: discount?.discount?.coupon?.id ?? null,
    coupon_name: discount?.discount?.coupon?.name ?? null,
    promotion_code: discount?.discount?.promotion_code
      ? String((discount.discount.promotion_code as any)?.code ?? discount.discount.promotion_code)
      : null,
    balance_transaction_id: (session as any).balance_transaction ?? null,
    status: session.status ?? 'unknown',
    payment_status: session.payment_status ?? 'unknown',
  };
}

export async function cancelFreeSubscriptionForUpgrade(
  oldSubscriptionId: string,
  accountId: string,
): Promise<void> {
  try {
    const stripe = getStripe();
    const oldSub = await stripe.subscriptions.retrieve(oldSubscriptionId);
    if (oldSub.status === 'canceled' || oldSub.status === 'incomplete_expired') {
      console.log(`[Billing] Old free subscription ${oldSubscriptionId} already cancelled for ${accountId}`);
      return;
    }
    await stripe.subscriptions.cancel(oldSubscriptionId);
    console.log(`[Billing] Cancelled old free subscription ${oldSubscriptionId} for ${accountId}`);
  } catch (err: any) {
    if (err?.code === 'resource_missing' || err?.statusCode === 404) {
      console.log(`[Billing] Old free subscription ${oldSubscriptionId} not found (already deleted) for ${accountId}`);
      return;
    }
    console.error(`[Billing] Failed to cancel old free subscription ${oldSubscriptionId} for ${accountId}:`, err);
    throw err;
  }
}
