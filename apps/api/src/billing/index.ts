import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { config } from '../config';

import { accountStateRouter } from './routes/account-state';
import { subscriptionsRouter } from './routes/subscriptions';
import { paymentsRouter } from './routes/payments';
import { webhooksRouter } from './routes/webhooks';
import { accountDeletionRouter } from './routes/account-deletion';

const billingApp = new Hono();

// Webhooks — NO auth (handlers verify signatures internally)
billingApp.route('/webhooks', webhooksRouter);

// Auth for all billing routes except webhooks
billingApp.use('*', async (c, next) => {
  if (c.req.path.includes('/webhooks')) {
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

// Billing routes — subscriptions and payments (all require billing enabled)
billingApp.route('/', subscriptionsRouter);
billingApp.route('/', paymentsRouter);

// Account deletion (mounted at /v1/billing/account/*)
billingApp.route('/account', accountDeletionRouter);

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

export { billingApp };
