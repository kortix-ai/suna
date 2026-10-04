import { createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { config } from '../../lib/config';
import { runWorkerTick } from '../../services/audit/audit-scope';
import { supabaseAuth } from '../middleware/auth';
import { errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../../types/app-env';

import { accountDeletionRouter } from './account-deletion';
import { accountStateRouter } from './account-state';
import { creditsRouter } from './credits';
import { paymentsRouter } from './payments';
import { subscriptionsRouter } from './subscriptions';
import { webhooksRouter } from './webhooks';

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
  if (c.req.path.includes('/cron/')) {
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
  if (c.req.path.includes('/account-state') || c.req.path.includes('/webhooks') || c.req.path.includes('/cron/')) {
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

function timingSafeStringEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function requireInternalCronAuth(c: Context<AppEnv>): Response | null {
  const authHeader = c.req.header('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const header = c.req.header('X-Kortix-Internal-Key') ?? '';
  const expected = config.INTERNAL_SERVICE_KEY;
  const ok =
    (bearer && timingSafeStringEqual(bearer, expected)) ||
    (header && timingSafeStringEqual(header, expected));

  if (!ok) {
    return c.json({ error: 'Internal cron authentication required' }, 401);
  }
  return null;
}

// Yearly credit rotation cron endpoint
billingApp.openapi(
  createRoute({
    method: 'post',
    path: '/cron/yearly-rotation',
    tags: ['billing'],
    summary: 'Run the yearly credit rotation (cron)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Rotation result'),
      ...errors(401),
    },
  }),
  async (c: Context<AppEnv>) => {
    const authError = requireInternalCronAuth(c);
    if (authError) return authError as any;
    if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
      return c.json({ skipped: true, reason: 'billing disabled' });
    }
    const { processYearlyCreditRotation } = await import('../../services/billing/services/yearly-rotation');
    const result = await processYearlyCreditRotation();
    return c.json(result);
  },
);

// Free-tier monthly credit rotation cron endpoint
billingApp.openapi(
  createRoute({
    method: 'post',
    path: '/cron/free-tier-rotation',
    tags: ['billing'],
    summary: 'Run the free-tier monthly credit rotation (cron)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Rotation result'),
      ...errors(401),
    },
  }),
  async (c: Context<AppEnv>) => {
    const authError = requireInternalCronAuth(c);
    if (authError) return authError as any;
    if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
      return c.json({ skipped: true, reason: 'billing disabled' });
    }
    const { processFreeTierCreditRotation } = await import('../../services/billing/services/free-tier-rotation');
    const result = await processFreeTierCreditRotation();
    return c.json(result);
  },
);

// Trial-expiry sweep cron endpoint. Pure status hygiene: the trial overlay
// stops granting lazily at trial_ends_at (resolve-billing.ts trialIsActive);
// this flips trial_status to 'expired' so rows read honestly.
billingApp.openapi(
  createRoute({
    method: 'post',
    path: '/cron/trial-expiry',
    tags: ['billing'],
    summary: 'Sweep expired trials (cron)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Sweep result'),
      ...errors(401),
    },
  }),
  async (c: Context<AppEnv>) => {
    const authError = requireInternalCronAuth(c);
    if (authError) return authError as any;
    if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
      return c.json({ skipped: true, reason: 'billing disabled' });
    }
    const { sweepExpiredTrials, sweepTrialMonthlyGrants } = await import('../../services/billing/services/trial-admin');
    const expired = await sweepExpiredTrials();
    const monthlyRegrants = await sweepTrialMonthlyGrants();
    return c.json({ expired, monthly_regrants: monthlyRegrants });
  },
);

export { billingApp, accountDeletionApp };
