/** Public ingress for app events: `POST /v1/webhooks/events/:provider`, authenticated by the provider's signature. */
import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { errors, json } from '../openapi';
import { projectWebhooksApp } from '../projects/lib/app';
import { bindIntegrationPrincipal } from '../shared/audit-scope';
import { applyNotices, deliverEvents } from './deliver';
import { eventSourceFor } from './registry';
import { EventSignatureError } from './types';

const IngressResultSchema = z.object({
  accepted: z.number(),
  fired: z.number(),
  skipped: z.number(),
  ignored: z.number(),
});

/** A provider event is a few KB; the cap bounds what an unauthenticated caller makes us buffer before the signature check. */
export const EVENT_INGRESS_MAX_BYTES = 1024 * 1024;

export function registerEventIngressRoutes(): void {
  projectWebhooksApp.use(
    '/events/*',
    bodyLimit({ maxSize: EVENT_INGRESS_MAX_BYTES, onError: (c) => c.json({ error: 'Payload too large' }, 413) }),
  );
  projectWebhooksApp.openapi(createRoute({
    method: 'post',
    path: '/events/{provider}',
    tags: ['triggers'],
    summary: 'Receive an app event',
    description:
      'Authenticated by the event provider signature, not a bearer token. Fans each delivery out to the event triggers subscribed to it. Answers 500 when any fire failed, so the provider retries; the idempotency key dedupes the fires that succeeded.',
    // No body schema: the provider signs the raw bytes, so nothing may parse them first.
    request: { params: z.object({ provider: z.string() }) },
    responses: {
      200: json(IngressResultSchema, 'Every delivery fired, skipped or ignored'),
      ...errors(401, 404, 413, 500, 503),
    },
  }), async (c) => {
    const provider = eventSourceFor(c.req.param('provider'));
    if (!provider) return c.json({ error: 'Unknown event provider' }, 404);
    if (!provider.ingressConfigured()) return c.json({ error: 'event_ingress_not_configured' }, 503);

    let received;
    try {
      received = await provider.receive({ headers: c.req.raw.headers, rawBody: await c.req.text() });
    } catch (error) {
      if (error instanceof EventSignatureError) return c.json({ error: 'Invalid webhook signature' }, 401);
      throw error;
    }
    bindIntegrationPrincipal(`${provider.id}_events`);

    await applyNotices(provider.id, received.notices);
    const tally = await deliverEvents(provider.id, received.deliveries);
    if (tally.failed > 0) return c.json({ error: 'Failed to fire an event trigger' }, 500);
    return c.json({
      accepted: received.deliveries.length,
      fired: tally.fired,
      skipped: tally.skipped,
      ignored: tally.ignored,
    }, 200);
  });
}
