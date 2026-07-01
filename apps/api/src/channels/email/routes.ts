import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import type { Context } from 'hono';
import { sharedConfig as config } from '../../shared/effect';
import { errors, json } from '../../openapi';
import {
  dependency,
  failJson,
  fireAndLog,
  jsonResponse,
  parseJsonString,
  parseRawBody,
  runChannelWorkflow,
} from '../effect-workflows';
import { loadAgentMailWebhookSecretForInbox } from '../install-store';
import { emailWebhookApp } from './app';
import { dispatchAgentMailEvent, resolveProjectForAgentMailInbox } from './session';
import type { AgentMailMessageReceivedEvent } from './types';
import { verifyAgentMailSignature } from './verify';

const agentMailWebhookWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const rawBody = yield* parseRawBody(c);
    const event = yield* parseJsonString<AgentMailMessageReceivedEvent>(rawBody);

    if (!event?.event_type || !event.message?.inbox_id) {
      return jsonResponse({ ok: true });
    }

    const projectId = yield* dependency(() =>
      resolveProjectForAgentMailInbox(event.message.inbox_id),
    );
    const secret = projectId
      ? yield* dependency(() =>
          loadAgentMailWebhookSecretForInbox(projectId, event.message.inbox_id),
        )
      : config.AGENTMAIL_WEBHOOK_SECRET;

    if (!secret && process.env.NODE_ENV === 'production') {
      return yield* failJson({ error: 'AgentMail webhook signing is not configured' }, 503);
    }

    // Signature verification intentionally stays raw-body based; parsing above
    // must not become the bytes Slack/Svix signed.
    if (secret) {
      const ok = verifyAgentMailSignature({
        rawBody,
        secret,
        svixId: c.req.header('svix-id') ?? '',
        svixTimestamp: c.req.header('svix-timestamp') ?? '',
        svixSignature: c.req.header('svix-signature') ?? '',
      });
      if (!ok) return yield* failJson({ error: 'Invalid signature' }, 401);
    }

    fireAndLog(
      '[email-webhook] handler failed',
      dependency(() => dispatchAgentMailEvent(event)),
    );
    return jsonResponse({ ok: true });
  });

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
  async (c: Context) => {
    return runChannelWorkflow(c, agentMailWebhookWorkflow(c));
  },
);
