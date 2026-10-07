import { createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { config } from '../config';
import { supabaseAuth } from '../middleware/auth';
import { errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';

import { accountDeletionRouter } from './routes/account-deletion';
import { accountStateRouter } from './routes/account-state';
import { creditsRouter } from './routes/credits';
import { paymentsRouter } from './routes/payments';
import { subscriptionsRouter } from './routes/subscriptions';
import { webhooksRouter } from './routes/webhooks';
import { bearerToken } from '../shared/bearer-token';

const billingApp = makeOpenApiApp<AppEnv>();
const accountDeletionApp = makeOpenApiApp<AppEnv>();

// Webhooks — NO auth (handlers verify signatures internally)
billingApp.route('/webhooks', webhooksRouter);
// Alias: /webhook → /webhooks (some providers send to singular form)
billingApp.route('/webhook', webhooksRouter);

// Auth-skip is an exact prefix match on the mounted path. A substring test
// (`includes('/webhook')`) would skip auth on any future param route whose
// value contains the word.
const UNAUTHENTICATED_BILLING_PATH = /^\/v1\/billing\/(webhooks?|cron)(\/|$)/;
const BILLING_GATE_EXEMPT_PATH = /^\/v1\/billing\/(account-state|webhooks|cron)(\/|$)/;
export const isUnauthenticatedBillingPath = (path: string) => UNAUTHENTICATED_BILLING_PATH.test(path);
export const isBillingGateExemptPath = (path: string) => BILLING_GATE_EXEMPT_PATH.test(path);

// Auth for all billing routes except webhooks and the cron endpoints (they
// verify a signature or the internal bearer themselves).
billingApp.use('*', async (c, next) => {
  if (isUnauthenticatedBillingPath(c.req.path)) return next();
  return supabaseAuth(c, next);
});

// Account state — always available (returns unlimited mock when billing disabled)
billingApp.route('/account-state', accountStateRouter);

// ── Billing gate ────────────────────────────────────────────────────────────
// Everything below requires billing to be enabled. Self-hosted / local users
// never hit Stripe, never get blocked by credits, never see subscription UI.
// Account-state (above) already returns the "Local (Unlimited)" mock.
billingApp.use('*', async (c, next) => {
  if (isBillingGateExemptPath(c.req.path)) {
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

// Account deletion API (mounted at /v1/account/*). No billing gate: every
// deployment deletes accounts, billing or not. Its billing steps (Stripe
// cancel, wallet forfeit) find nothing to do without billing.
accountDeletionApp.use('*', supabaseAuth);
accountDeletionApp.route('/', accountDeletionRouter);

function timingSafeStringEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function requireInternalCronAuth(c: Context<AppEnv>): Response | null {
  const authHeader = c.req.header('Authorization');
  const bearer = bearerToken(authHeader) ?? '';
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
    const { processYearlyCreditRotation } = await import('./services/yearly-rotation');
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
    const { processFreeTierCreditRotation } = await import('./services/free-tier-rotation');
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
    const { sweepExpiredTrials, sweepTrialMonthlyGrants } = await import('./services/trial-admin');
    const expired = await sweepExpiredTrials();
    const monthlyRegrants = await sweepTrialMonthlyGrants();
    return c.json({ expired, monthly_regrants: monthlyRegrants });
  },
);

export { billingApp, accountDeletionApp };
