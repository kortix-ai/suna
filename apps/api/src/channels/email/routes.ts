import { createRoute, z } from '@hono/zod-openapi';
import { json, errors } from '../../openapi';
import { loadEmailWebhookSecretForInbox } from '../install-store';
import { emailWebhookApp } from './app';
import { dispatchResendEmailEvent, emailChannelOnForProject, resolveProjectForEmailInbox } from './session';
import { verifyEmailWebhookSignature } from './verify';
import type { ResendInboxEmailReceivedEvent } from './types';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';
import { runWebhookWork } from '../webhook-work';

export function registerEmailWebhookRoutes(): void {
  emailWebhookApp.openapi(
    createRoute({
      method: 'post',
      path: '/resend',
      tags: ['channels'],
      summary: 'Resend inbound email webhook (Svix signature verified)',
      request: {
        body: { content: { 'application/json': { schema: z.any() } } },
      },
      responses: {
        200: json(z.object({ ok: z.boolean(), ignored: z.boolean().optional() }), 'Accepted'),
        ...errors(400, 401),
      },
    }),
    async (c: any) => {
      const rawBody = await c.req.text();
      let event: ResendInboxEmailReceivedEvent;
      try {
        event = JSON.parse(rawBody) as ResendInboxEmailReceivedEvent;
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      // A malformed body is refused before any ack: answering 200 to `{}` let
      // an unauthenticated caller poison ack/monitoring (pentest NEW-1).
      if (typeof event?.type !== 'string' || typeof event.data?.inbox_id !== 'string' || !event.data.inbox_id) {
        return c.json({ error: 'Missing type or data.inbox_id' }, 400);
      }

      // Kortix's Resend team is shared by dev, staging and prod, and its
      // webhooks are team-wide: an inbox another environment owns arrives here
      // too. With no install there is no secret to check and nothing to do.
      // A project with the email channel off (`email_channel`) is ignored too.
      const projectId = await resolveProjectForEmailInbox(event.data.inbox_id);
      if (!projectId || !(await emailChannelOnForProject(projectId))) return c.json({ ok: true, ignored: true });
      const secret = await loadEmailWebhookSecretForInbox(projectId, event.data.inbox_id);
      if (!secret) return c.json({ ok: true, ignored: true });

      const ok = verifyEmailWebhookSignature({
        rawBody,
        secret,
        svixId: c.req.header('svix-id') ?? c.req.header('webhook-id') ?? '',
        svixTimestamp: c.req.header('svix-timestamp') ?? c.req.header('webhook-timestamp') ?? '',
        svixSignature: c.req.header('svix-signature') ?? c.req.header('webhook-signature') ?? '',
      });
      if (!ok) {
        console.warn('[email-webhook] signature verification failed', {
          inboxId: event.data.inbox_id,
          hasSvixId: Boolean(c.req.header('svix-id')),
          hasSvixSignature: Boolean(c.req.header('svix-signature')),
        });
        return c.json({ error: 'Invalid signature' }, 401);
      }
      bindIntegrationPrincipal('resend');

      // A failure inside the ack window answers 500 so Resend retries; the
      // dedup claims are released first (`webhook-work.ts`).
      const outcome = await runWebhookWork('email-webhook', () => dispatchResendEmailEvent(event));
      if (outcome === 'failed') return c.json({ error: 'processing failed' }, 500);
      return c.json({ ok: true });
    },
  );
}
