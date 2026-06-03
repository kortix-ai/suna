import { getStripe } from '../../shared/stripe';
import {
  getCreditAccount,
  updateCreditAccount,
  upsertCreditAccount,
} from '../repositories/credit-accounts';
import { getCustomerByAccountId, upsertCustomer, deleteCustomerByStripeId } from '../repositories/customers';
import { BillingError } from '../../errors';
import { getTier, resolvePriceId, getComputeDisplayPriceCents, getComputeProductId, getComputeDescription, resolvePerSeatPriceId, MAX_SEATS_PER_ACCOUNT } from './tiers';
import { countActiveMembers } from './seat-management';
import { isPlatformAdmin } from '../../shared/platform-roles';
import Stripe from 'stripe';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';

/** True for Stripe's "No such customer" (resource_missing). */
function isStripeNoSuchCustomer(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string; raw?: { code?: string }; message?: string };
  return e?.statusCode === 404
    || e?.code === 'resource_missing'
    || e?.raw?.code === 'resource_missing'
    || /no such customer/i.test(e?.message ?? '');
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
    if (!isStripeNoSuchCustomer(err)) throw err;
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

async function getUsableCustomerPaymentMethod(customerId: string): Promise<string | null> {
  const stripe = getStripe();
  try {
    let defaultPaymentMethodId: string | null = null;
    const stripeCustomer = await stripe.customers.retrieve(customerId);
    if (!('deleted' in stripeCustomer) || !stripeCustomer.deleted) {
      const defaultPm = stripeCustomer.invoice_settings?.default_payment_method;
      if (typeof defaultPm === 'string') {
        defaultPaymentMethodId = defaultPm;
      } else if (defaultPm && typeof defaultPm === 'object' && 'id' in defaultPm) {
        defaultPaymentMethodId = defaultPm.id;
      }
    }

    const methods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1,
    });

    return defaultPaymentMethodId ?? methods.data[0]?.id ?? null;
  } catch (err) {
    console.warn(`[Billing] Could not resolve saved payment method for customer ${customerId}:`, err);
    return null;
  }
}

export async function createCheckoutSession(params: {
  accountId: string;
  email: string;
  tierKey: string;
  successUrl: string;
  cancelUrl: string;
  commitmentType?: string;
  locale?: string;
  serverType?: string;
  location?: string;
}) {
  const { accountId, email, tierKey, successUrl, cancelUrl, commitmentType, locale, serverType, location } = params;
  const tier = getTier(tierKey);
  if (tier.name === 'none') throw new BillingError('Invalid tier');

  const customerId = await getOrCreateStripeCustomer(accountId, email);
  const stripe = getStripe();
  const adminCheckout = await isPlatformAdmin(accountId);
  const account = await getCreditAccount(accountId);
  const previousFreeSubscriptionId =
    (account?.tier ?? 'free') === 'free' && account?.stripeSubscriptionId
      ? account.stripeSubscriptionId
      : undefined;

  const priceId = resolvePriceId(tierKey, commitmentType);
  if (!priceId) throw new BillingError('No price configured for this tier');

  const metadata = {
    account_id: accountId,
    tier_key: tierKey,
    commitment_type: commitmentType ?? 'monthly',
    ...(previousFreeSubscriptionId ? { previous_subscription_id: previousFreeSubscriptionId } : {}),
    ...(serverType ? { server_type: serverType } : {}),
    ...(location ? { location } : {}),
  };

  // If the customer already has a saved card, create and charge the subscription
  // directly. No hosted Checkout page for repeat instance purchases.
  //
  // When a server_type is provided, use the canonical compute display price
  // (from COMPUTE_TIERS) instead of the base tier price.  This keeps
  // the Stripe charge in sync with the prices shown in the frontend modal.
  const computePriceCents = serverType ? getComputeDisplayPriceCents(serverType) : null;

  const savedPaymentMethodId = adminCheckout ? null : await getUsableCustomerPaymentMethod(customerId);
  if (savedPaymentMethodId) {
    try {
      const subscriptionItems: Stripe.SubscriptionCreateParams.Item[] = computePriceCents != null
        ? [{
            price_data: {
              currency: 'usd',
              product: getComputeProductId(),
              unit_amount: adminCheckout ? 0 : computePriceCents,
              recurring: { interval: 'month' },
            },
          }]
        : [{ price: priceId }];

      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: subscriptionItems,
        collection_method: 'charge_automatically',
        default_payment_method: savedPaymentMethodId,
        payment_behavior: 'error_if_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata,
        ...(serverType ? { description: getComputeDescription(serverType) } : {}),
      });

      if (subscription.status === 'active' || subscription.status === 'trialing') {
        await upsertCreditAccount(accountId, {
          tier: tierKey,
          provider: 'stripe',
          stripeSubscriptionId: subscription.id,
          stripeSubscriptionStatus: subscription.status,
          paymentStatus: 'active',
          // Auto-topup on by default: charge $5 when balance drops below $1
          autoTopupEnabled: true,
          autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
          autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
        });

        await upsertCustomer({
          accountId,
          id: customerId,
          email,
          provider: 'stripe',
          active: true,
        });

        return {
          status: 'subscription_created' as const,
          subscription_id: subscription.id,
          message: 'Instance purchase successful',
        };
      }
    } catch (err) {
      console.warn(`[Billing] Direct subscription creation failed for ${accountId}, falling back to Checkout:`, err instanceof Error ? err.message : err);
    }
  }

  // Fallback: hosted Checkout for first purchase / no saved card / SCA-required payment.
  // Uses inline product_data so the checkout page shows "Kortix Computer" with
  // actual machine specs — no provider names, regions, or internal tier keys.
  let unitAmount: number;
  let interval: Stripe.Price.Recurring.Interval = 'month';

  if (computePriceCents != null) {
    unitAmount = adminCheckout ? 0 : computePriceCents;
  } else {
    const stripePrice = await stripe.prices.retrieve(priceId);
    unitAmount = adminCheckout ? 0 : stripePrice.unit_amount!;
    interval = stripePrice.recurring?.interval ?? 'month';
  }

  // Always use product_data so the Stripe Checkout page shows a clean,
  // user-facing name with actual machine specs — no provider names or regions.
  const computeDesc = serverType ? getComputeDescription(serverType) : null;

  const lineItemPriceData: Stripe.Checkout.SessionCreateParams.LineItem['price_data'] = {
    currency: 'usd',
    unit_amount: unitAmount,
    recurring: { interval },
    product_data: {
      name: 'Kortix Computer',
      description: computeDesc ?? 'Cloud computer + LLM credits',
    },
  };

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{
      price_data: lineItemPriceData,
      quantity: 1,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    payment_method_collection: adminCheckout ? 'if_required' : 'always',
    subscription_data: {
      metadata,
      ...(computeDesc ? { description: computeDesc } : {}),
    },
    metadata: {
      ...metadata,
      ...(adminCheckout ? { admin_checkout: 'true' } : {}),
    },
    ...(locale ? { locale: locale as any } : {}),
  });

  return {
    status: 'checkout_created' as const,
    checkout_url: session.url,
    session_id: session.id,
  };
}

/**
 * Billing v2 — start a per-seat subscription.
 *
 * Creates a Stripe subscription with `quantity = current member count`. If a
 * payment method is saved we charge it directly; otherwise we hand off to
 * hosted Checkout. The seat-grant of included compute/YOLO credits is applied
 * by the `customer.subscription.updated` webhook (services/webhooks.ts) so we
 * have a single source of truth for "credits granted per seat".
 */
export async function createPerSeatCheckoutSession(params: {
  accountId: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
  locale?: string;
}) {
  const { accountId, email, successUrl, cancelUrl, locale } = params;

  const priceId = resolvePerSeatPriceId();
  if (!priceId) {
    throw new BillingError(
      'Per-seat price is not configured. Set STRIPE_PRICES.subscriptions.per_seat for this environment.',
    );
  }

  const seatCount = Math.min(MAX_SEATS_PER_ACCOUNT, Math.max(1, await countActiveMembers(accountId)));
  const customerId = await getOrCreateStripeCustomer(accountId, email);
  const stripe = getStripe();

  const metadata = {
    account_id: accountId,
    tier_key: 'per_seat',
    billing_model: 'per_seat',
    initial_seat_count: String(seatCount),
  };

  // Always hand off to Stripe's hosted Checkout for per-seat activation.
  //
  // We used to instant-create the subscription when a card was already on file
  // (returning the `subscription_created` shape with no redirect). That short-
  // circuit produced a "Subscription activated" toast without ever showing the
  // real Stripe checkout — and any hiccup in the off-session charge left the
  // account looking activated when it wasn't. Routing every subscribe through
  // Checkout makes activation real and webhook-driven (single source of truth:
  // seat item + credit grant are applied by customer.subscription.* webhooks).
  // Returning customers still get a fast, card-prefilled Checkout page.
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: seatCount }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    payment_method_collection: 'always',
    subscription_data: { metadata },
    metadata,
    ...(locale ? { locale: locale as any } : {}),
  });

  return {
    status: 'checkout_created' as const,
    checkout_url: session.url,
    session_id: session.id,
    seat_count: seatCount,
  };
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

export async function cancelFreeSubscriptionForUpgrade(
  oldSubscriptionId: string,
  accountId: string,
): Promise<void> {
  try {
    const stripe = getStripe();
    const oldSub = await stripe.subscriptions.retrieve(oldSubscriptionId);
    if (oldSub.status === 'canceled' || oldSub.status === 'incomplete_expired') {
      return;
    }
    await stripe.subscriptions.cancel(oldSubscriptionId);
  } catch (err: any) {
    if (err?.code === 'resource_missing' || err?.statusCode === 404) {
      return;
    }
    console.error(`[Billing] Failed to cancel old free subscription ${oldSubscriptionId} for ${accountId}:`, err);
    throw err;
  }
}
