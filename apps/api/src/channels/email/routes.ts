import { createRoute, z } from '@hono/zod-openapi';
import { json, errors } from '../../openapi';
import { config } from '../../config';
import { emitIntegrationEvent } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import {
  emailOwnKeyForAccount,
  emailWebhookSecretForAccount,
  loadEmailInboxAccountForInbox,
  updateEmailAccountWebhook,
} from '../install-store';
import { ensureResendInboxWebhook, resolveEmailApiKey } from '../resend-email-api';
import { emailWebhookApp } from './app';
import { emailChannelOnForProject, emailMessageEvent, isEmailSenderAllowed, resolveProjectForEmailInbox } from './session';
import { verifyEmailWebhookSignature } from './verify';
import type { ResendInboxEmailReceivedEvent } from './types';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';

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
        ...errors(400, 401, 500),
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
      const account = await loadEmailInboxAccountForInbox(projectId, event.data.inbox_id);
      const secret = account ? await emailWebhookSecretForAccount(account) : null;
      if (!account || !secret) return c.json({ ok: true, ignored: true });

      const signature = {
        rawBody,
        svixId: c.req.header('svix-id') ?? c.req.header('webhook-id') ?? '',
        svixTimestamp: c.req.header('svix-timestamp') ?? c.req.header('webhook-timestamp') ?? '',
        svixSignature: c.req.header('svix-signature') ?? c.req.header('webhook-signature') ?? '',
      };
      let ok = verifyEmailWebhookSignature({ ...signature, secret });
      if (!ok) {
        // The account may hold the secret of a webhook that was replaced. Ask
        // Resend once for the team's current one, then verify again.
        const fresh = await refreshedWebhookSecret(projectId, event.data.inbox_id, c.req.url);
        if (fresh && fresh !== secret) ok = verifyEmailWebhookSignature({ ...signature, secret: fresh });
      }
      if (!ok) {
        console.warn('[email-webhook] signature verification failed', {
          inboxId: event.data.inbox_id,
          hasSvixId: Boolean(c.req.header('svix-id')),
          hasSvixSignature: Boolean(c.req.header('svix-signature')),
        });
        return c.json({ error: 'Invalid signature' }, 401);
      }
      bindIntegrationPrincipal('resend', { projectId });

      const inbound = emailMessageEvent(projectId, event);
      if (!inbound) return c.json({ ok: true, ignored: true });
      // The inbox's sender policy gates the store: a rejected sender's mail is never kept.
      const sender = String(inbound.data.from);
      if (!isEmailSenderAllowed(sender, account.senderPolicy)) {
        logger.warn('[email-webhook] sender rejected by inbox policy', { inboxId: event.data.inbox_id, emailId: inbound.id, sender });
        return c.json({ ok: true, ignored: true });
      }
      // Ack only after the store: a crash after the 200 loses nothing, and a
      // Resend retry of a stored email is a no-op. A failed store answers 500,
      // so Resend retries it.
      try {
        await emitIntegrationEvent(inbound);
      } catch (error) {
        logger.error('[email-webhook] email not stored', { inboxId: event.data.inbox_id, emailId: inbound.id, error: String(error) });
        return c.json({ error: 'store failed' }, 500);
      }
      return c.json({ ok: true });
    },
  );
}

/** Per inbox: when its secret was last refreshed, so junk POSTs cannot make Resend calls in a loop. */
// replica-local: a per-process rate limit; each replica refreshes at most once a minute per inbox.
const lastWebhookRefresh = new Map<string, number>();
const WEBHOOK_REFRESH_INTERVAL_MS = 60_000;

/**
 * The current signing secret of the webhook that delivers `inboxId`'s mail to
 * this API, stored on its account. Null when it was refreshed within the last
 * minute or Resend cannot say.
 */
async function refreshedWebhookSecret(projectId: string, inboxId: string, requestUrl: string): Promise<string | null> {
  const last = lastWebhookRefresh.get(inboxId) ?? 0;
  if (Date.now() - last < WEBHOOK_REFRESH_INTERVAL_MS) return null;
  lastWebhookRefresh.set(inboxId, Date.now());
  try {
    const account = await loadEmailInboxAccountForInbox(projectId, inboxId);
    if (!account) return null;
    const apiKey = resolveEmailApiKey(await emailOwnKeyForAccount(account));
    if (!apiKey) return null;
    const endpoint = `${(config.KORTIX_URL || new URL(requestUrl).origin).replace(/\/+$/, '')}/v1/webhooks/email/resend`;
    const webhook = await ensureResendInboxWebhook(apiKey, endpoint);
    await updateEmailAccountWebhook(account, webhook);
    return webhook.signing_secret;
  } catch {
    return null;
  }
}
