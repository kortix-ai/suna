import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import { config } from '../../config';
import { processStripeWebhook, processRevenueCatWebhook } from '../services/webhooks';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { attemptBilling, billingFail, parseJsonBody, runBillingEffect } from './effect-workflows';

export const webhooksRouter = makeOpenApiApp();

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
      ...errors(400, 500),
    },
  }),
  async (c: any) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const signature = c.req.header('stripe-signature');
      if (!signature) return yield* billingFail('Missing stripe-signature header', 400);
      if (!config.STRIPE_WEBHOOK_SECRET) return yield* billingFail('Webhook not configured', 500);

      const rawBody = yield* attemptBilling<string>(() => c.req.text());
      return yield* attemptBilling(() => processStripeWebhook(rawBody, signature));
    }));
    return c.json(result);
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
    const result = await runBillingEffect(Effect.gen(function* () {
      if (!config.REVENUECAT_WEBHOOK_SECRET) {
        return yield* billingFail('Webhook not configured', 500);
      }

      const authHeader = c.req.header('Authorization');
      if (!authHeader || authHeader !== `Bearer ${config.REVENUECAT_WEBHOOK_SECRET}`) {
        return yield* billingFail('Unauthorized', 401);
      }

      const body = yield* parseJsonBody<Record<string, unknown>>(c);
      return yield* attemptBilling(() => processRevenueCatWebhook(body));
    }));
    return c.json(result);
  },
);

// Sandbox lifecycle webhooks (Daytona/Platinum) live at /v1/webhooks/sandbox/*
// (platform/webhooks/routes.ts) — they're provider state events, not billing.
