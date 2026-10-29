/**
 * The one webhook route every chat channel mounts: `POST /{projectId}` under
 * the channel's own prefix. The steps, in order: body limit, the zod-openapi
 * checks, verify, audit principal, parse, normalize, store, reply. A throw in
 * normalize or the store reaches the global onError (http-errors.ts), so the
 * platform gets a 500 and retries. See ./inbound.ts for the adapter contract.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Counter, registerMetricRenderer } from '../../lib/metrics';
import { errors, json, makeOpenApiApp } from '../../openapi';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';
import { type ChannelInbound, type InboundReply, ingestChannelEvents } from './inbound';

const requests = new Counter(
  'channel_webhook_requests_total',
  'Channel webhook requests by platform and outcome: accepted, duplicate, ignored, rejected, bad_request, too_large.',
);
registerMetricRenderer(() => requests.render());

type Outcome = 'accepted' | 'duplicate' | 'ignored' | 'rejected' | 'bad_request' | 'too_large';

function send(c: Context, reply: InboundReply) {
  return reply.body === null || reply.status === 204 ? c.body(null, reply.status) : c.json(reply.body, reply.status);
}

/** A sub-app with the channel's route registered; mount it with `app.route()`. */
export function channelWebhookRoutes<V extends { projectId: string }>(channel: ChannelInbound<V>) {
  const app = makeOpenApiApp();
  const count = (outcome: Outcome) => requests.inc({ platform: channel.platform, outcome });

  app.use(
    '/*',
    bodyLimit({
      maxSize: channel.maxBytes ?? 1024 * 1024,
      onError: (c) => {
        count('too_large');
        return c.json({ error: 'Payload too large' }, 413);
      },
    }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}',
      tags: ['channels'],
      summary: channel.summary,
      request: {
        // A project id is always a UUID. Without this, a non-UUID path segment
        // reached the projects DB lookup, which threw on the invalid input and
        // surfaced as a 500 to an anonymous caller (pentest 2026-10-22).
        params: z.object({ projectId: z.string().uuid() }),
        // Declared so the spec documents a JSON body. The JSON check reads the
        // body as text first, so `c.req.text()` still returns the raw bytes.
        body: { content: { 'application/json': { schema: z.any() } } },
      },
      responses: {
        200: json(z.record(z.string(), z.unknown()), 'Accepted, or the reply the platform expects'),
        204: { description: 'Accepted; the platform expects no body' },
        ...errors(400, 401, 404, 413, 500),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const rawBody = await c.req.text();
      const verdict = await channel.verify({ projectId, header: (name) => c.req.header(name), rawBody });
      if (!('verified' in verdict)) {
        count(verdict.status >= 400 ? 'rejected' : 'ignored');
        return send(c, verdict);
      }
      // Only a verified request is attributed; a forged one stays anonymous.
      bindIntegrationPrincipal(channel.principal ?? channel.platform, { projectId });

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        count('bad_request');
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      const { events, reply } = await channel.normalize(body, verdict.verified);
      // The reply goes out only after every event is stored, so a crash after it loses nothing.
      const stored = await ingestChannelEvents(events, { maxAttempts: channel.maxAttempts });
      count(stored === 'stored' ? 'accepted' : stored === 'none' ? 'ignored' : 'duplicate');
      return reply ? send(c, reply) : c.json({ ok: true }, 200);
    },
  );
  return app;
}
