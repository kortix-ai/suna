import { Hono } from 'hono';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { supabaseAuth } from '../middleware/auth';
import { config } from '../config';

import { accountStateRouter } from './routes/account-state';
import { subscriptionsRouter } from './routes/subscriptions';
import { paymentsRouter } from './routes/payments';
import { creditsRouter } from './routes/credits';
import { webhooksRouter } from './routes/webhooks';
import { accountDeletionRouter } from './routes/account-deletion';

const billingApp = new Hono();
const accountDeletionApp = new Hono();

// Webhooks — NO auth (handlers verify signatures internally)
billingApp.route('/webhooks', webhooksRouter);
// Alias: /webhook → /webhooks (some providers send to singular form)
billingApp.route('/webhook', webhooksRouter);

// Auth for all billing routes except webhooks
billingApp.use('*', async (c, next) => {
  if (c.req.path.includes('/webhook')) {
    return next();
  }
  return supabaseAuth(c, next);
});

// Account state — always available (returns unlimited mock when billing disabled)
billingApp.route('/account-state', accountStateRouter);

// ── Billing gate ────────────────────────────────────────────────────────────
// Everything below requires billing to be enabled. Self-hosted / local users
// never hit Stripe, never get blocked by credits, never see subscription UI.
// Account-state (above) already returns the "Local (Unlimited)" mock.
billingApp.use('*', async (c, next) => {
  if (c.req.path.includes('/account-state') || c.req.path.includes('/webhooks')) {
    return next();
  }
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return c.json({ error: 'Billing is not enabled', billing_disabled: true }, 404);
  }
  return next();
});

// Setup initialize endpoint (requires billing — creates Stripe subscription + sandbox)
// DESIGN: Returns fast (<2s). Kicks off sandbox provisioning in the background.
// Sandbox status is polled via GET /platform/sandbox/:id/status.
billingApp.post('/setup/initialize', async (c: any) => {
  const userId = c.get('userId') as string;
  const email = c.get('userEmail') as string;
  const body = await c.req.json().catch(() => ({}));
  const requestedServerType = (body?.server_type as string | undefined) || undefined;
  const requestedLocation = (body?.location as string | undefined) || undefined;
  // Accept optional tier_key — defaults to 'starter' for new signups.
  // Falls back to 'free' if the requested tier has no Stripe price configured.
  const requestedTierKey = (body?.tier_key as string | undefined) || 'starter';
  const { upsertCreditAccount, getCreditAccount } = await import('./repositories/credit-accounts');
  const { resolvePriceId, isPaidTier } = await import('./services/tiers');
  const { getOrCreateStripeCustomer } = await import('./services/subscriptions');
  const { resolveAccountId } = await import('../shared/resolve-account');

  const accountId = await resolveAccountId(userId);

  // ── Step 1: Create Stripe subscription at the requested tier ──────────
  const existing = await getCreditAccount(accountId);
  let subscriptionStatus: 'already_initialized' | 'initialized' = 'initialized';
  // Track the effective tier after initialization (existing or newly created)
  let effectiveTier = existing?.tier ?? 'free';

  if (existing?.stripeSubscriptionId) {
    subscriptionStatus = 'already_initialized';
  } else {
    const customerId = await getOrCreateStripeCustomer(accountId, email);
    const { getStripe } = await import('../shared/stripe');
    const stripe = getStripe();

    // Resolve price for the requested tier; fall back to free if not configured
    let tierKey = requestedTierKey;
    let priceId = resolvePriceId(tierKey, 'monthly');
    if (!priceId) {
      console.warn(`[setup/initialize] No price for tier '${tierKey}', falling back to free`);
      tierKey = 'free';
      priceId = resolvePriceId('free', 'monthly');
    }
    if (!priceId) {
      return c.json({ error: 'Free tier price not configured' }, 500);
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'allow_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata: { account_id: accountId, tier_key: tierKey },
    });

    await upsertCreditAccount(accountId, {
      tier: tierKey,
      provider: 'stripe',
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: 'active',
      planType: 'monthly',
      balance: '0',
      dailyCreditsBalance: '0',
      autoTopupEnabled: false,
      autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
      autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
    });

    effectiveTier = tierKey;
  }

  // ── Step 2: Sandbox provisioning ─────────────────────────────────────
  // Free tier: no sandbox — user connects their own (BYOC).
  // Starter + paid tiers: provision managed sandbox.
  let sandboxStatus: 'created' | 'exists' | 'provisioning' | 'skipped' | 'failed' = 'skipped';

  if (!isPaidTier(effectiveTier)) {
    console.log(`[setup/initialize] Free tier — no sandbox provisioning for account ${accountId}`);
  } else {
    // Starter tier gets a managed sandbox automatically on signup.
    // Pro tier: machine creation is explicit via checkout, but trigger provisioning
    // if server_type was provided (e.g. from the new-machine flow).
    if (requestedServerType) {
      try {
        const { provisionSandboxFromCheckout } = await import('../platform/services/sandbox-provisioner');
        const subId = existing?.stripeSubscriptionId ?? 'starter-init';
        await provisionSandboxFromCheckout({
          accountId,
          subscriptionId: subId,
          serverType: requestedServerType,
          location: requestedLocation,
          tierKey: effectiveTier,
        });
        sandboxStatus = 'provisioning';
        console.log(`[setup/initialize] Sandbox provisioning started for ${accountId} (tier: ${effectiveTier})`);
      } catch (err) {
        sandboxStatus = 'failed';
        console.warn(`[setup/initialize] Sandbox provisioning failed for ${accountId}:`, err instanceof Error ? err.message : String(err));
      }
    } else {
      console.log(`[setup/initialize] ${effectiveTier} tier — sandbox provisioning available via machine checkout for account ${accountId}`);
    }
  }

  return c.json({
    status: subscriptionStatus,
    tier: effectiveTier,
    sandbox: sandboxStatus,
  });
});

// Billing routes — subscriptions, payments, credits (all require billing enabled)
billingApp.route('/', subscriptionsRouter);
billingApp.route('/', paymentsRouter);
billingApp.route('/', creditsRouter);

// Account deletion (mounted at /v1/billing/account/*)
billingApp.route('/account', accountDeletionRouter);

// Backwards-compatible account deletion API (mounted at /v1/account/*)
accountDeletionApp.use('*', supabaseAuth);
accountDeletionApp.use('*', async (c, next) => {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return c.json({ error: 'Billing is not enabled', billing_disabled: true }, 404);
  }
  return next();
});
accountDeletionApp.route('/', accountDeletionRouter);

// Yearly credit rotation cron endpoint
billingApp.post('/cron/yearly-rotation', async (c: any) => {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return c.json({ skipped: true, reason: 'billing disabled' });
  }
  const { processYearlyCreditRotation } = await import('./services/yearly-rotation');
  const result = await processYearlyCreditRotation();
  return c.json(result);
});

if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
  const YEARLY_ROTATION_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const { processYearlyCreditRotation } = await import('./services/yearly-rotation');
      await processYearlyCreditRotation();
    } catch (err) {
      console.error('[BillingApp] Yearly rotation interval error:', err);
    }
  }, YEARLY_ROTATION_INTERVAL_MS);
}

export { billingApp, accountDeletionApp };
