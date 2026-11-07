import { createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { processStripeWebhook, processRevenueCatWebhook } from '../services/webhooks';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';

export const webhooksRouter = makeOpenApiApp();

// Constant-time compare, mirroring platform/webhooks/sandbox-webhooks.ts's
// safeEqual — never throws on length mismatch, no early-exit timing leak.
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Public, signature-verified. Raw request body is required for Stripe signature
// verification, so we deliberately DO NOT declare a JSON `request.body` schema
// here — that would make zod-openapi consume/validate the body and break the
// raw-body read these handlers depend on. No bearer security either.
webhooksRouter.openapi(
  createRoute({
    method: 'post',
    path: '/stripe',
    tags: ['billing'],
    summary: 'Stripe webhook (signature-verified, public)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Webhook processing result'),
      ...errors(400, 500, 503),
    },
  }),
  async (c: any) => {
    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json({ error: 'Missing stripe-signature header' }, 400);
    if (!config.STRIPE_WEBHOOK_SECRET) return c.json({ error: 'Webhook not configured' }, 500);

    const rawBody = await c.req.text();
    try {
      const result = await processStripeWebhook(rawBody, signature);
      return c.json(result);
    } catch (error) {
      // Stripe rate-limiting our own API calls is a retryable condition, not a
      // bug: answer 503 so Stripe redelivers (the dedupe marker is only written
      // after success) instead of throwing a 500 that pages as a new error.
      if (!(error instanceof Stripe.errors.StripeRateLimitError)) throw error;
      logger.warn('[Webhook] Stripe rate limit while processing event; asking Stripe to redeliver');
      c.header('Retry-After', '60');
      return c.json({ error: 'Stripe rate limited; retry later' }, 503);
    }
  },
);

webhooksRouter.openapi(
  createRoute({
    method: 'post',
    path: '/revenuecat',
    tags: ['billing'],
    summary: 'RevenueCat webhook (bearer-secret verified, public)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Webhook processing result'),
      ...errors(401, 500),
    },
  }),
  async (c: any) => {
    if (!config.REVENUECAT_WEBHOOK_SECRET) {
      return c.json({ error: 'Webhook not configured' }, 500);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !safeEqual(authHeader, `Bearer ${config.REVENUECAT_WEBHOOK_SECRET}`)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    bindIntegrationPrincipal('revenuecat');

    const body = await c.req.json();
    const result = await processRevenueCatWebhook(body);
    return c.json(result);
  },
);

// Sandbox lifecycle webhooks (Daytona/Platinum) live at /v1/webhooks/sandbox/*
// (platform/webhooks/routes.ts) — they're provider state events, not billing.
