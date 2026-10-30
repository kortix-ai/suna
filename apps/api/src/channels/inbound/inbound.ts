/**
 * The inbound half of every chat channel. A channel's webhook verifies the
 * request, turns its body into integration events, and stores them in the
 * event inbox (integrations/event-inbox.ts) before it answers. The route that
 * runs those steps is `channelWebhookRoutes` (./webhook-routes.ts). This file
 * and that one name no platform (eslint.config.mjs).
 *
 * Add a channel:
 *   1. Adapter: a `ChannelInbound` in `channels/<platform>/inbound.ts`. Each event names its conversation
 *      (`subject`) and, when the platform numbers its updates, its `sequence`: one conversation's events
 *      then reach its session in send order.
 *   2. Consumer: `registerEventConsumer('<platform>.', …)`, in a module the
 *      adapter imports, so the consumer registers wherever the route loads.
 *   3. Mount: `app.route('/v1/webhooks/<platform>', channelWebhookRoutes(<platform>Inbound))` in app.ts.
 *   4. Audit label: the route's line in packages/shared/src/audit-route-labels.ts.
 *   5. Manifest: `bun run apps/api/scripts/dump-routes.ts`, commit tests/spec/routes.generated.json.
 *   6. Flow: a tests/src/flows case that sends a signed update and reads the reply.
 *   7. Lint: add `'../<platform>*'` to `NO_PLATFORM` in apps/api/eslint.config.mjs.
 *   8. Commands: after the sender gate, `parseChannelCommand` (or the platform's native command) →
 *      `runChannelCommand` with a renderer (channels/core/commands.ts) that records a sent reply with
 *      buttons (`rememberCommandMenu`), and `runCommandPress` for a press on such a reply's button (a
 *      `kc:` token, channels/core/command-press.ts); `turnModel` on the
 *      port and `chatSessionStart` in `plan()` (channels/core/model-choice.ts); a menu registrar is optional.
 */
import { timingSafeEqual } from 'node:crypto';
import { emitIntegrationEvent, type IntegrationEvent } from '../../integrations/event-inbox';

/** An answer the route sends as is: a refusal, a probe answer, or a platform's synchronous reply. A null body sends no body. */
export type InboundReply = { status: 200 | 204 | 401 | 404; body: Record<string, unknown> | null };

export interface InboundRequest {
  projectId: string;
  header(name: string): string | undefined;
  /** The request body exactly as sent, for a signature over the raw bytes. */
  rawBody: string;
}

export interface ChannelInbound<V extends { projectId: string }> {
  /** The metric label, and the audit principal unless `principal` is set. Never an id. */
  platform: string;
  /** The route's OpenAPI summary. */
  summary: string;
  principal?: string;
  /** job_queue.max_attempts of each stored event. Default: the column default, 8. */
  maxAttempts?: number;
  /** The largest body the route reads. Default 1 MiB; a larger one gets 413 before `verify`. */
  maxBytes?: number;
  /** Prove the request came from the platform. A reply refuses it, answers a probe, or ignores it: nothing is stored. */
  verify(req: InboundRequest): Promise<{ verified: V } | InboundReply>;
  /** The events in a verified body, and the reply to send once they are stored. May read the DB; never writes it. */
  normalize(body: unknown, verified: V): Promise<{ events: IntegrationEvent[]; reply?: InboundReply }>;
}

/** Constant-time string compare, so a secret cannot be recovered from response timing. */
export function safeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Store events in order. 'stored' when at least one is new, 'duplicate' when
 * every one was stored before, 'none' when there are none. A failed store
 * throws: the events before it stay stored, and the platform's retry stores
 * the rest once.
 */
export async function ingestChannelEvents(
  events: IntegrationEvent[],
  opts: { maxAttempts?: number } = {},
): Promise<'stored' | 'duplicate' | 'none'> {
  let outcome: 'stored' | 'duplicate' | 'none' = 'none';
  for (const event of events) {
    if (await emitIntegrationEvent(event, opts)) outcome = 'stored';
    else if (outcome === 'none') outcome = 'duplicate';
  }
  return outcome;
}
