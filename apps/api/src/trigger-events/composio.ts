import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { composioConfigured, composioUserId, getComposioRuntime } from '../connectors/composio';
import { EventConnectionNotReadyError, type EventDelivery, EventSignatureError, type EventSourceProvider, type EventTypeInfo, type ProviderNotice } from './types';

const TOLERANCE_S = 5 * 60;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function triggers() {
  const t = getComposioRuntime().triggers;
  if (!t) throw new Error('Composio runtime does not expose triggers');
  return t;
}

/**
 * Composio V3 signature, per `@composio/core` Triggers.verifyWebhookSignature (dist/index.mjs):
 * HMAC-SHA256 keyed with the secret's raw UTF-8 bytes (NOT base64-decoded, so
 * `lib/webhooks/standard-webhooks.ts` computes a different MAC), over
 * `${webhook-id}.${webhook-timestamp}.${rawBody}`, base64 output, header `v1,<sig>[ v1,<sig>...]`.
 */
function verifySignature(headers: Headers, rawBody: string, secret: string): void {
  const id = headers.get('webhook-id') ?? '';
  const timestamp = headers.get('webhook-timestamp') ?? '';
  const signature = headers.get('webhook-signature') ?? '';
  const ts = Number.parseInt(timestamp, 10);
  if (!secret || !id || !signature || !rawBody || Number.isNaN(ts)) throw new EventSignatureError();
  if (Math.abs(Date.now() - ts * 1000) > TOLERANCE_S * 1000) throw new EventSignatureError('Webhook timestamp outside tolerance');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest('base64'));
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return;
  }
  throw new EventSignatureError();
}

function isNotFound(error: unknown): boolean {
  const e = error as { status?: unknown; cause?: { status?: unknown } } | null;
  return e?.status === 404 || e?.cause?.status === 404;
}

/**
 * `@composio/core` 0.17 drops the trigger type's `type` field ('poll' | 'webhook'),
 * so a polling trigger is also recognised by its `interval` config property.
 */
function deliveryOf(type: unknown, configSchema: Record<string, unknown>): EventTypeInfo['delivery'] {
  if (type === 'poll') return 'poll';
  if (type === 'webhook') return 'push';
  const properties = configSchema.properties as Record<string, unknown> | undefined;
  return properties && 'interval' in properties ? 'poll' : null;
}

export const composioEventSource: EventSourceProvider = {
  id: 'composio',
  configured: () => composioConfigured(),
  ingressConfigured: () => Boolean(config.COMPOSIO_WEBHOOK_SECRET),

  async listEventTypes(app) {
    const out: EventTypeInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await triggers().listTypes({ toolkits: [app], limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      for (const item of res.items) {
        out.push({
          type: item.slug,
          name: item.name,
          description: item.description,
          app: item.toolkit?.slug ?? app,
          delivery: deliveryOf(item.type, asRecord(item.config)),
          configSchema: asRecord(item.config),
          payloadSchema: item.payload && Object.keys(item.payload).length ? asRecord(item.payload) : null,
        });
      }
      cursor = res.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  },

  async subscribe({ connection, type, config: triggerConfig }) {
    const connectedAccountId = str(connection.metadata.connected_account_id);
    if (!connectedAccountId) {
      throw new EventConnectionNotReadyError(`Finish connecting the shared ${connection.app} account to activate this trigger.`);
    }
    const res = await triggers().create(composioUserId(connection.connectionId), type, { connectedAccountId, triggerConfig });
    return { externalId: res.triggerId };
  },

  async unsubscribe(externalId) {
    try {
      await triggers().delete(externalId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },

  async receive({ headers, rawBody }) {
    verifySignature(headers, rawBody, config.COMPOSIO_WEBHOOK_SECRET ?? '');
    const deliveries: EventDelivery[] = [];
    const notices: ProviderNotice[] = [];
    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(rawBody));
    } catch {
      return { deliveries, notices };
    }
    const meta = asRecord(body.metadata);
    const data = asRecord(body.data);
    switch (body.type) {
      case 'composio.trigger.message': {
        const externalId = str(meta.trigger_id);
        if (!externalId) break;
        deliveries.push({
          externalId,
          eventId: str(body.id) || headers.get('webhook-id') || str(meta.log_id),
          type: str(meta.trigger_slug),
          occurredAt: str(body.timestamp) || new Date().toISOString(),
          data: body.data,
        });
        break;
      }
      case 'composio.trigger.disabled': {
        const externalId = str(meta.trigger_id) || str(data.trigger_id) || str(data.id);
        if (externalId) notices.push({ kind: 'subscription_disabled', externalId, reason: str(data.reason) || str(data.message) || 'Composio disabled the trigger.' });
        break;
      }
      case 'composio.connected_account.expired': {
        const connectionExternalId = str(meta.connected_account_id) || str(data.connected_account_id) || str(data.id) || str(meta.id);
        if (connectionExternalId) notices.push({ kind: 'connection_expired', connectionExternalId, reason: str(data.reason) || str(data.message) || 'The connected account expired.' });
        break;
      }
    }
    return { deliveries, notices };
  },
};
