import { createRoute, z } from '@hono/zod-openapi';
import { errors, json } from '../../openapi';
import { loadWhatsAppWebhookSecretForAccount } from '../install-store';
import { whatsappWebhookApp } from './app';
import { dispatchWhatsAppEvent, resolveProjectForWhatsAppAccount } from './session';
import type { WhatsAppGatewayEvent } from './types';
import { verifyWhatsAppSignature } from './verify';

whatsappWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/gateway',
    tags: ['channels'],
    summary: 'Kortix WhatsApp Gateway inbound webhook (HMAC signature verified)',
    request: {
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Accepted'),
      ...errors(400, 401, 503),
    },
  }),
  async (c: any) => {
    const rawBody = await c.req.text();
    let event: WhatsAppGatewayEvent;
    try {
      event = JSON.parse(rawBody) as WhatsAppGatewayEvent;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    // Reject malformed unsigned bodies before acking, so an unauthenticated
    // caller cannot poison delivery monitoring with `{}` -> 200.
    if (!event?.type || !event.account_id) {
      return c.json({ error: 'Missing type or account_id' }, 400);
    }

    const projectId = await resolveProjectForWhatsAppAccount(event.account_id);
    const secret = projectId
      ? await loadWhatsAppWebhookSecretForAccount(projectId, event.account_id)
      : null;
    if (!secret) {
      return c.json({ error: 'WhatsApp webhook signing is not configured' }, 503);
    }

    const ok = verifyWhatsAppSignature({
      rawBody,
      secret,
      timestamp: c.req.header('x-whatsapp-timestamp') ?? '',
      signature: c.req.header('x-whatsapp-signature') ?? '',
    });
    if (!ok) return c.json({ error: 'Invalid signature' }, 401);

    void dispatchWhatsAppEvent(event).catch((err) => {
      console.error('[whatsapp-webhook] handler failed', err);
    });
    return c.json({ ok: true });
  },
);
