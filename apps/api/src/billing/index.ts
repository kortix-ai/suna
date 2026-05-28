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

// Setup initialize endpoint.
//
// Billing v2 — every new account is born on the per-seat plan. There is no
// free tier for new signups. We seed credit_accounts with
// billing_model='per_seat', tier='per_seat', seat_count=1, balance=$0.
// The user then completes Stripe Checkout (Settings → Billing → Subscribe)
// to activate their first seat and land the $20 wallet grant.
//
// Existing rows (tier='free', billing_model='legacy') are preserved untouched.
billingApp.post('/setup/initialize', async (c: any) => {
  const userId = c.get('userId') as string;
  void c.get('userEmail');
  await c.req.json().catch(() => ({}));
  const { upsertCreditAccount, getCreditAccount } = await import('./repositories/credit-accounts');
  const { defaultAutoTopupForSeats } = await import('./services/tiers');
  const { resolveAccountId } = await import('../shared/resolve-account');

  const accountId = await resolveAccountId(userId);

  const existing = await getCreditAccount(accountId);
  let subscriptionStatus: 'already_initialized' | 'initialized' = 'initialized';

  if (existing) {
    // Pre-existing account — leave alone. Legacy customers stay legacy;
    // per-seat customers keep whatever subscription state they have.
    subscriptionStatus = 'already_initialized';
  } else {
    // Fresh account — seed as per-seat with no subscription yet. The user
    // will land at $0 balance and see the "Subscribe to Team plan" CTA.
    const defaults = defaultAutoTopupForSeats(1);
    await upsertCreditAccount(accountId, {
      tier: 'per_seat',
      billingModel: 'per_seat',
      seatCount: 1,
      provider: 'stripe',
      balance: '0',
      dailyCreditsBalance: '0',
      autoTopupEnabled: false,
      autoTopupThreshold: String(defaults.threshold),
      autoTopupAmount: String(defaults.amount),
    });
    console.log(`[setup/initialize] Seeded per_seat account ${accountId} (awaiting Stripe checkout)`);
  }

  return c.json({
    status: subscriptionStatus,
    tier: existing?.tier ?? 'per_seat',
    sandbox: 'skipped' as const,
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
