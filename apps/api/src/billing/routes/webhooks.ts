import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../../config';
import { processStripeWebhook, processRevenueCatWebhook } from '../services/webhooks';
import { makeOpenApiApp, json, errors } from '../../openapi';

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
    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json({ error: 'Missing stripe-signature header' }, 400);
    if (!config.STRIPE_WEBHOOK_SECRET) return c.json({ error: 'Webhook not configured' }, 500);

    const rawBody = await c.req.text();
    const result = await processStripeWebhook(rawBody, signature);
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
    if (!config.REVENUECAT_WEBHOOK_SECRET) {
      return c.json({ error: 'Webhook not configured' }, 500);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader || authHeader !== `Bearer ${config.REVENUECAT_WEBHOOK_SECRET}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json();
    const result = await processRevenueCatWebhook(body);
    return c.json(result);
  },
);
