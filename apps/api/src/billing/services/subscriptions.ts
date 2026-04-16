import { getStripe } from '../../shared/stripe';
import { db } from '../../shared/db';
import { eq } from 'drizzle-orm';
import {
  getCreditAccount,
  updateCreditAccount,
  upsertCreditAccount,
} from '../repositories/credit-accounts';
import { getCustomerByAccountId, upsertCustomer } from '../repositories/customers';
import { BillingError, SubscriptionError } from '../../errors';
import { getTier, isUpgrade, isDowngrade, getMonthlyCredits, resolvePriceId, getComputeDisplayPriceCents, getComputeProductId, getComputeDescription } from './tiers';
import { grantCredits, resetExpiringCredits } from './credits';
import { isPlatformAdmin } from '../../shared/platform-roles';
import Stripe from 'stripe';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';

export async function getOrCreateStripeCustomer(
  accountId: string,
  email: string,
): Promise<string> {
  const existing = await getCustomerByAccountId(accountId);
  if (existing) return existing.id;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
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

  const priceId = resolvePriceId(tierKey, commitmentType);
  if (!priceId) throw new BillingError('No price configured for this tier');

  const metadata = {
    account_id: accountId,
    tier_key: tierKey,
    commitment_type: commitmentType ?? 'monthly',
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

        if (serverType) {
          const { provisionSandboxFromCheckout } = await import('../../platform/services/sandbox-provisioner');
          await provisionSandboxFromCheckout({
            accountId,
            subscriptionId: subscription.id,
            serverType,
            location: location || undefined,
            tierKey,
          });
        }

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
      account_id: accountId,
      tier_key: tierKey,
      ...(serverType ? { server_type: serverType } : {}),
      ...(location ? { location } : {}),
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

export async function createInlineCheckout(params: {
  accountId: string;
  email: string;
  tierKey: string;
  billingPeriod: 'monthly' | 'yearly';
  promoCode?: string;
}) {
  const { accountId, email, tierKey, billingPeriod, promoCode } = params;
  const tier = getTier(tierKey);
  if (tier.name === 'none') throw new BillingError('Invalid tier');

  const account = await getCreditAccount(accountId);
  const currentTier = account?.tier ?? 'free';

  if (account?.stripeSubscriptionId && currentTier !== 'free' && isUpgrade(currentTier, tierKey)) {
    return handleUpgrade(accountId, account.stripeSubscriptionId, tierKey, billingPeriod);
  }

  const previousFreeSubscriptionId =
    currentTier === 'free' && account?.stripeSubscriptionId
      ? account.stripeSubscriptionId
      : undefined;

  const customerId = await getOrCreateStripeCustomer(accountId, email);
  const stripe = getStripe();

  const priceId = resolvePriceId(tierKey, billingPeriod);
  if (!priceId) throw new BillingError('No price configured for this tier/period');

  const subscriptionParams: any = {
    customer: customerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: {
      account_id: accountId,
      tier_key: tierKey,
      billing_period: billingPeriod,
      ...(previousFreeSubscriptionId ? { previous_subscription_id: previousFreeSubscriptionId } : {}),
    },
  };

  if (promoCode) {
    const promos = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
    if (promos.data.length > 0) {
      subscriptionParams.promotion_code = promos.data[0].id;
    }
  }

  const subscription = await stripe.subscriptions.create(subscriptionParams);
  const invoice = subscription.latest_invoice as any;
  const paymentIntent = invoice?.payment_intent as any;

  if (invoice?.amount_due === 0) {
    await activateSubscription(accountId, subscription.id, tierKey, billingPeriod);
    if (previousFreeSubscriptionId) {
      await cancelFreeSubscriptionForUpgrade(previousFreeSubscriptionId, accountId);
    }
    return {
      subscription_id: subscription.id,
      tier_key: tierKey,
      no_payment_required: true,
    };
  }

  return {
    client_secret: paymentIntent?.client_secret ?? null,
    subscription_id: subscription.id,
    tier_key: tierKey,
    amount: invoice?.amount_due,
    currency: invoice?.currency,
    ...(previousFreeSubscriptionId ? { previous_subscription_id: previousFreeSubscriptionId } : {}),
  };
}

export async function confirmInlineCheckout(params: {
  accountId: string;
  subscriptionId: string;
  tierKey: string;
}) {
  const { accountId, subscriptionId, tierKey } = params;
  const stripe = getStripe();

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    throw new SubscriptionError('Subscription is not active');
  }

  const billingPeriod = (subscription.metadata?.billing_period ?? 'monthly') as string;
  await activateSubscription(accountId, subscriptionId, tierKey, billingPeriod);

  const previousSubscriptionId = subscription.metadata?.previous_subscription_id;
  if (previousSubscriptionId) {
    await cancelFreeSubscriptionForUpgrade(previousSubscriptionId, accountId);
  }

  return { success: true, tier: tierKey, message: 'Subscription activated' };
}

export async function createPortalSession(accountId: string, returnUrl: string, email?: string) {
  let customer = await getCustomerByAccountId(accountId);
  if (!customer) {
    if (!email) throw new BillingError('No billing customer found');
    const customerId = await getOrCreateStripeCustomer(accountId, email);
    customer = { id: customerId } as typeof customer;
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customer.id,
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
  await stripe.subscriptions.update(account.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });

  return { success: true, message: 'Subscription reactivated' };
}

export async function scheduleDowngrade(
  accountId: string,
  targetTierKey: string,
  commitmentType?: string,
) {
  const account = await getCreditAccount(accountId);
  if (!account?.stripeSubscriptionId) throw new SubscriptionError('No active subscription');

  const currentTier = getTier(account.tier ?? 'free');
  const targetTier = getTier(targetTierKey);

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);

  let currentPeriodEnd = subscription.current_period_end;
  if (account.commitmentType === 'yearly_commitment' && account.commitmentEndDate) {
    const commitmentEnd = new Date(account.commitmentEndDate);
    if (commitmentEnd > new Date()) {
      currentPeriodEnd = Math.floor(commitmentEnd.getTime() / 1000);
    }
  }
  const effectiveDate = new Date(currentPeriodEnd * 1000).toISOString();

  const newPriceId = resolvePriceId(targetTierKey, commitmentType);
  if (!newPriceId) throw new BillingError('No price configured for target tier');

  await createOrUpdateSubscriptionSchedule({
    subscriptionId: account.stripeSubscriptionId,
    subscription,
    targetPriceId: newPriceId,
    currentPeriodEnd,
    accountId,
    currentTierName: currentTier.name,
    targetTierKey,
  });

  await updateCreditAccount(accountId, {
    scheduledTierChange: targetTierKey,
    scheduledTierChangeDate: effectiveDate,
    scheduledPriceId: newPriceId,
  });

  return {
    success: true,
    message: `Downgrade to ${targetTier.displayName} scheduled`,
    scheduled_date: effectiveDate,
    current_tier: {
      name: currentTier.name,
      display_name: currentTier.displayName,
      monthly_credits: currentTier.monthlyCredits,
    },
    target_tier: {
      name: targetTier.name,
      display_name: targetTier.displayName,
      monthly_credits: targetTier.monthlyCredits,
    },
    billing_change: true,
    current_billing_period: account.planType ?? 'monthly',
    target_billing_period: commitmentType ?? 'monthly',
    change_description: `Your plan will change from ${currentTier.displayName} to ${targetTier.displayName} at the end of your billing period.`,
  };
}

export async function cancelScheduledChange(accountId: string) {
  const account = await getCreditAccount(accountId);

  await updateCreditAccount(accountId, {
    scheduledTierChange: null,
    scheduledTierChangeDate: null,
    scheduledPriceId: null,
  });

  if (account?.stripeSubscriptionId) {
    const stripe = getStripe();
    try {
      const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);
      const scheduleId = typeof subscription.schedule === 'string'
        ? subscription.schedule
        : (subscription.schedule as any)?.id;

      if (scheduleId) {
        try {
          await stripe.subscriptionSchedules.release(scheduleId);
          console.log(`[Billing] Released schedule ${scheduleId} for ${accountId}`);
        } catch (releaseErr) {
          console.warn(`[Billing] Could not release schedule ${scheduleId}:`, releaseErr);
        }
      }

      await stripe.subscriptions.update(account.stripeSubscriptionId, {
        metadata: {
          ...subscription.metadata,
          downgrade: '',
          target_tier: '',
          scheduled_change: '',
        },
      });
    } catch (err) {
      console.warn(`[Billing] Error clearing Stripe schedule for ${accountId}:`, err);
    }
  }

  return { success: true, message: 'Scheduled change cancelled' };
}

async function createOrUpdateSubscriptionSchedule(params: {
  subscriptionId: string;
  subscription: any;
  targetPriceId: string;
  currentPeriodEnd: number;
  accountId: string;
  currentTierName: string;
  targetTierKey: string;
}) {
  const { subscriptionId, subscription, targetPriceId, currentPeriodEnd, accountId, currentTierName, targetTierKey } = params;
  const stripe = getStripe();
  const currentPriceId = subscription.items.data[0]?.price?.id;

  const scheduleMetadata: Record<string, string> = {
    account_id: accountId,
    downgrade: 'true',
    previous_tier: currentTierName,
    target_tier: targetTierKey,
    scheduled_by: 'user',
    scheduled_at: new Date().toISOString(),
    scheduled_price_id: targetPriceId,
  };

  const existingScheduleId = typeof subscription.schedule === 'string'
    ? subscription.schedule
    : (subscription.schedule as any)?.id ?? null;

  if (existingScheduleId) {
    const handled = await handleExistingSchedule(
      existingScheduleId, subscription, targetPriceId, currentPeriodEnd, scheduleMetadata,
    );
    if (handled) return;
  }

  const schedule = await stripe.subscriptionSchedules.create({
    from_subscription: subscriptionId,
  });

  await stripe.subscriptionSchedules.update(schedule.id, {
    phases: [
      {
        items: [{ price: currentPriceId, quantity: 1 }],
        start_date: subscription.current_period_start,
        end_date: currentPeriodEnd,
        proration_behavior: 'none',
      },
      {
        items: [{ price: targetPriceId, quantity: 1 }],
        proration_behavior: 'none',
      },
    ],
    end_behavior: 'release',
    metadata: scheduleMetadata,
  });

  console.log(`[Billing] Created subscription schedule ${schedule.id} for downgrade of ${accountId}`);
}

async function handleExistingSchedule(
  existingScheduleId: string,
  subscription: any,
  targetPriceId: string,
  currentPeriodEnd: number,
  scheduleMetadata: Record<string, string>,
): Promise<boolean> {
  const stripe = getStripe();
  const currentPriceId = subscription.items.data[0]?.price?.id;

  try {
    const existingSchedule = await stripe.subscriptionSchedules.retrieve(existingScheduleId);
    const scheduleStatus = existingSchedule.status;

    if (scheduleStatus === 'active' || scheduleStatus === 'not_started') {
      const phases = existingSchedule.phases ?? [];
      const now = Math.floor(Date.now() / 1000);
      if (phases.length > 0 && phases[0].end_date && phases[0].end_date < now) {
        console.log(`[Billing] Schedule ${existingScheduleId} phase 0 has ended, releasing`);
        try { await stripe.subscriptionSchedules.release(existingScheduleId); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        return false;
      }

      await stripe.subscriptionSchedules.update(existingScheduleId, {
        phases: [
          {
            items: [{ price: currentPriceId, quantity: 1 }],
            start_date: subscription.current_period_start,
            end_date: currentPeriodEnd,
            proration_behavior: 'none',
          },
          {
            items: [{ price: targetPriceId, quantity: 1 }],
            proration_behavior: 'none',
          },
        ],
        end_behavior: 'release',
        metadata: scheduleMetadata,
      });
      console.log(`[Billing] Updated existing schedule ${existingScheduleId}`);
      return true;
    }

    try { await stripe.subscriptionSchedules.release(existingScheduleId); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    return false;
  } catch (err: any) {
    if (err?.code === 'resource_missing' || err?.message?.includes('No such subscription_schedule')) {
      return false;
    }
    if (err?.message?.includes('phase that has already ended')) {
      try { await stripe.subscriptionSchedules.release(existingScheduleId); } catch {}
      await new Promise(r => setTimeout(r, 1000));
      return false;
    }
    throw err;
  }
}

export async function releaseSubscriptionSchedule(subscriptionId: string): Promise<void> {
  const stripe = getStripe();
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const scheduleId = typeof subscription.schedule === 'string'
      ? subscription.schedule
      : (subscription.schedule as any)?.id;

    if (scheduleId) {
      await stripe.subscriptionSchedules.release(scheduleId);
      console.log(`[Billing] Released schedule ${scheduleId} before subscription update`);
    }
  } catch (err) {
    console.warn(`[Billing] Could not release schedule for ${subscriptionId}:`, err);
  }
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

export async function getCheckoutSessionDetails(sessionId: string) {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['total_details.breakdown'],
  });

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

export async function confirmCheckoutSession(params: {
  accountId: string;
  sessionId: string;
}) {
  const { accountId, sessionId } = params;
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'customer'],
  });

  if (session.mode !== 'subscription') {
    throw new BillingError('Checkout session is not a subscription session');
  }

  const sessionAccountId = session.metadata?.account_id;
  if (!sessionAccountId || sessionAccountId !== accountId) {
    throw new BillingError('Checkout session does not belong to this account');
  }

  const tierKey = session.metadata?.tier_key;
  if (!tierKey) {
    throw new BillingError('Missing tier_key in checkout session metadata');
  }

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;
  if (!subscriptionId) {
    return { success: false, status: 'pending', message: 'Subscription not attached yet' };
  }

  if (session.status !== 'complete' && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return { success: false, status: 'pending', message: 'Checkout payment is not completed yet' };
  }

  const commitmentType = session.metadata?.commitment_type ?? 'monthly';
  await activateSubscription(accountId, subscriptionId, tierKey, commitmentType);

  const tier = getTier(tierKey);
  if (tier.monthlyCredits > 0) {
    try {
      await grantCredits(
        accountId,
        tier.monthlyCredits,
        'tier_grant',
        `${tier.displayName} subscription activated: ${tier.monthlyCredits} credits`,
        true,
        session.id,
      );
    } catch (err) {
      console.error('[Billing] Failed to grant initial plan credits during checkout confirm:', err);
    }
  }

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

  const existing = await getCreditAccount(accountId);
  const previousSubscriptionId = session.metadata?.previous_subscription_id
    ?? (existing?.tier === 'free' ? existing?.stripeSubscriptionId : null);
  if (previousSubscriptionId && previousSubscriptionId !== subscriptionId) {
    await cancelFreeSubscriptionForUpgrade(previousSubscriptionId, accountId);
  }

  return { success: true, status: 'activated', tier: tierKey, subscription_id: subscriptionId };
}

export async function getProrationPreview(accountId: string, newPriceId: string) {
  const account = await getCreditAccount(accountId);
  if (!account?.stripeSubscriptionId) throw new SubscriptionError('No active subscription');

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);

  const invoice = await stripe.invoices.retrieveUpcoming({
    customer: subscription.customer as string,
    subscription: account.stripeSubscriptionId,
    subscription_items: [
      { id: subscription.items.data[0].id, price: newPriceId },
    ],
    subscription_proration_date: Math.floor(Date.now() / 1000),
  });

  return {
    amount_due: invoice.amount_due,
    currency: invoice.currency,
    proration_date: invoice.subscription_proration_date,
  };
}

async function handleUpgrade(
  accountId: string,
  subscriptionId: string,
  targetTierKey: string,
  commitmentType?: string,
) {
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const newPriceId = resolvePriceId(targetTierKey, commitmentType);
  if (!newPriceId) throw new BillingError('No price for target tier');

  const scheduleId = typeof subscription.schedule === 'string'
    ? subscription.schedule
    : (subscription.schedule as any)?.id;
  if (scheduleId) {
    try {
      await stripe.subscriptionSchedules.release(scheduleId);
      console.log(`[Billing] Released schedule ${scheduleId} before upgrade for ${accountId}`);
    } catch (err) {
      console.warn(`[Billing] Could not release schedule ${scheduleId}:`, err);
    }
  }

  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: subscription.items.data[0].id, price: newPriceId }],
    proration_behavior: 'always_invoice',
    payment_behavior: 'pending_if_incomplete',
    metadata: {
      ...subscription.metadata,
      tier_key: targetTierKey,
      previous_tier: subscription.metadata?.tier_key ?? 'unknown',
      downgrade: '',
      target_tier: '',
      scheduled_change: '',
    },
  });

  await activateSubscription(accountId, subscriptionId, targetTierKey, commitmentType ?? 'monthly');

  const targetTier = getTier(targetTierKey);
  const credits = targetTier.monthlyCredits;
  if (credits > 0) {
    await resetExpiringCredits(accountId, credits, `Plan upgrade to ${targetTier.displayName}: ${credits} credits`);
  }

  return {
    status: 'upgraded' as const,
    subscription_id: updated.id,
    message: `Upgraded to ${targetTier.displayName}`,
  };
}

async function activateSubscription(
  accountId: string,
  subscriptionId: string,
  tierKey: string,
  billingPeriod: string,
) {
  await upsertCreditAccount(accountId, {
    tier: tierKey,
    provider: 'stripe',
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: 'active',
    planType: billingPeriod,
    scheduledTierChange: null,
    scheduledTierChangeDate: null,
    scheduledPriceId: null,
  });
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
