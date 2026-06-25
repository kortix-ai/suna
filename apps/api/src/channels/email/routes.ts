import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../../config';
import { json, errors } from '../../openapi';
import { loadAgentMailWebhookSecretForInbox } from '../install-store';
import { emailWebhookApp } from './app';
import { dispatchAgentMailEvent, resolveProjectForAgentMailInbox } from './session';
import { verifyAgentMailSignature } from './verify';
import type { AgentMailMessageReceivedEvent } from './types';

emailWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/agentmail',
    tags: ['channels'],
    summary: 'AgentMail inbound email webhook (Svix signature verified)',
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
    let event: AgentMailMessageReceivedEvent;
    try {
      event = JSON.parse(rawBody) as AgentMailMessageReceivedEvent;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (event?.type !== 'event' || !event.event_type) return c.json({ ok: true });

    const projectId = event.message?.inbox_id
      ? await resolveProjectForAgentMailInbox(event.message.inbox_id)
      : null;
    const secret = projectId
      ? await loadAgentMailWebhookSecretForInbox(projectId, event.message.inbox_id)
      : config.AGENTMAIL_WEBHOOK_SECRET;
    if (!secret && process.env.NODE_ENV === 'production') {
      return c.json({ error: 'AgentMail webhook signing is not configured' }, 503);
    }
    if (secret) {
      const ok = verifyAgentMailSignature({
        rawBody,
        secret,
        svixId: c.req.header('svix-id') ?? '',
        svixTimestamp: c.req.header('svix-timestamp') ?? '',
        svixSignature: c.req.header('svix-signature') ?? '',
      });
      if (!ok) return c.json({ error: 'Invalid signature' }, 401);
    }

    void dispatchAgentMailEvent(event).catch((err) => {
      console.error('[email-webhook] handler failed', err);
    });
    return c.json({ ok: true });
  },
);
