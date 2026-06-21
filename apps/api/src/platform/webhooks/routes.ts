import { createRoute, z } from '@hono/zod-openapi';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { handleDaytonaWebhook, handlePlatinumWebhook } from './sandbox-webhooks';

/**
 * Sandbox lifecycle webhook ingress (NOT billing — these are provider state
 * events that we use to close compute billing + reconcile DB state the instant a
 * box stops). Mounted at /v1/webhooks/sandbox so the path says what it is.
 *
 * This is the FAST path of a deliberate two-tier strategy:
 *   1. webhook (here) — closes billing the moment the provider reports a stop;
 *   2. the reaper sweep (projects/sandbox-reaper.ts) — polls the provider's real
 *      state every maintenance cycle and reconciles/closes anything the webhook
 *      missed. The sweep needs ZERO per-environment config, so local/dev/preview
 *      are fully correct on the reaper alone; webhooks are a prod latency win,
 *      never a correctness dependency.
 *
 * Raw body is required for signature verification, so no JSON body schema is
 * declared. Inert (503) until the matching secret is configured.
 */
export const sandboxWebhooksApp = makeOpenApiApp();

sandboxWebhooksApp.openapi(
  createRoute({
    method: 'post',
    path: '/daytona',
    tags: ['webhooks'],
    summary: 'Daytona sandbox lifecycle webhook (Svix-signed, public)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Webhook processing result'),
      ...errors(400, 401, 503),
    },
  }),
  async (c: any) => {
    const rawBody = await c.req.text();
    const { status, body } = await handleDaytonaWebhook(rawBody, (h: string) => c.req.header(h));
    return c.json(body, status);
  },
);

sandboxWebhooksApp.openapi(
  createRoute({
    method: 'post',
    path: '/platinum',
    tags: ['webhooks'],
    summary: 'Platinum sandbox lifecycle webhook (HMAC-SHA-256, public)',
    responses: {
      200: json(z.record(z.string(), z.any()), 'Webhook processing result'),
      ...errors(400, 401, 503),
    },
  }),
  async (c: any) => {
    const rawBody = await c.req.text();
    const { status, body } = await handlePlatinumWebhook(rawBody, (h: string) => c.req.header(h));
    return c.json(body, status);
  },
);
