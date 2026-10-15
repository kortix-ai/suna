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
 * - Live subscription already on the credits price → change its quantity.
 *   A raise is charged now (`always_invoice`) and applies only once paid; the
 *   paid proration invoice grants its net amount. A cut bills no proration and
 *   the next renewal grants the new amount.
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

  const currentUsd = monthlyCreditsForSubscription(livePaid);
  const onCreditsPrice = livePaid.items.data.length === 1 && livePaid.items.data[0].price?.id === priceId;
  if (onCreditsPrice && currentUsd === monthlyUsd) {
    return { status: 'unchanged' as const, monthly_usd: monthlyUsd };
  }
  const isCut = onCreditsPrice && monthlyUsd < currentUsd;

  const updated = await stripe.subscriptions.update(livePaid.id, {
    items: onCreditsPrice
      ? [{ id: livePaid.items.data[0].id, quantity }]
      : [...livePaid.items.data.map((item) => ({ id: item.id, deleted: true })), { price: priceId, quantity }],
    proration_behavior: isCut ? 'none' : 'always_invoice',
    // A raise applies ONLY if its charge succeeds; on a failed payment Stripe
    // keeps the old items and returns a `pending_update` instead of throwing.
    ...(isCut ? {} : { payment_behavior: 'pending_if_incomplete' as const }),
    expand: ['latest_invoice.payment_intent'],
    metadata: { ...livePaid.metadata, tier_key: 'credits', plan_key: 'credits' },
  });

  if (isCut) {
    await applyStripeSync(
      accountId,
      { tier: 'credits', planMonthlyUsd: String(monthlyUsd) },
      { mode: 'update', reason: 'set-plan:cut' },
    );
    return { status: 'updated' as const, monthly_usd: monthlyUsd };
  }

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
    { tier: 'credits', planMonthlyUsd: String(monthlyUsd) },
    { mode: 'update', reason: 'set-plan:raise' },
  );
  await grantForPaidProrationInvoice(accountId, invoice);
  return { status: 'updated' as const, monthly_usd: monthlyUsd };
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
