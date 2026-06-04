import { createRoute, z } from '@hono/zod-openapi';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { supabaseAuth } from '../middleware/auth';
import { config } from '../config';
import type { AppEnv } from '../types';
import { makeOpenApiApp, json } from '../openapi';

import { accountStateRouter } from './routes/account-state';
import { subscriptionsRouter } from './routes/subscriptions';
import { paymentsRouter } from './routes/payments';
import { creditsRouter } from './routes/credits';
import { webhooksRouter } from './routes/webhooks';
import { accountDeletionRouter } from './routes/account-deletion';

const billingApp = makeOpenApiApp<AppEnv>();
const accountDeletionApp = makeOpenApiApp<AppEnv>();

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
billingApp.openapi(
  createRoute({
    method: 'post',
    path: '/cron/yearly-rotation',
    tags: ['billing'],
    summary: 'Run the yearly credit rotation (cron)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Rotation result'),
    },
  }),
  async (c: any) => {
    if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
      return c.json({ skipped: true, reason: 'billing disabled' });
    }
    const { processYearlyCreditRotation } = await import('./services/yearly-rotation');
    const result = await processYearlyCreditRotation();
    return c.json(result);
  },
);

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
