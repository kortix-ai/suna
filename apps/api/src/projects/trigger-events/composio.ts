import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import { composioConfigured, composioUserId, getComposioRuntime } from '../../connectors/composio';
import { EventConnectionNotReadyError, type EventApp, type EventDelivery, EventSignatureError, type EventSourceProvider, type EventTypeInfo, type ProviderNotice } from './types';

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

/**
 * The person-readable reason inside a Composio API error (`400 {"error":{"message":…}}`),
 * and inside that, the upstream app's own validation message when Composio nests it.
 */
export function composioErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const message = JSON.parse(raw.slice(raw.indexOf('{'))).error?.message;
    if (typeof message !== 'string') return raw;
    const nestedAt = message.indexOf('{');
    if (nestedAt < 0) return message;
    const detail = JSON.parse(message.slice(nestedAt)).errors?.[0]?.message;
    return typeof detail === 'string' ? `${message.slice(0, nestedAt).replace(/[\s:]+$/, '')}: ${detail}` : message;
  } catch {
    return raw;
  }
}

const KORTIX_CONNECTION = /^kortix-connection:([0-9a-f-]{36})$/;

/** The Kortix connection id inside any string value of a payload, or null. */
export function kortixConnectionIn(value: unknown): string | null {
  if (typeof value === 'string') return KORTIX_CONNECTION.exec(value)?.[1] ?? null;
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      const found = kortixConnectionIn(child);
      if (found) return found;
    }
  }
  return null;
}

async function connectionOfAccount(accountId: string): Promise<string | null> {
  try {
    const account = (await getComposioRuntime().connectedAccounts?.get(accountId)) as Record<string, unknown> | null | undefined;
    return kortixConnectionIn(account?.user_id ?? account?.userId);
  } catch {
    return null;
  }
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

  async listApps() {
    const toolkits = getComposioRuntime().toolkits;
    if (!toolkits) throw new Error('Composio toolkit catalogue is unavailable');
    // Offer only apps a project can connect: the connectors catalog's own hidden set.
    const { composioHiddenToolkits } = await import('../../connectors/composio-catalog-search');
    const hidden = await composioHiddenToolkits();
    const apps: EventApp[] = [];
    for (const t of await toolkits.get({ limit: 1000 })) {
      const eventCount = t.meta?.triggersCount ?? t.meta?.triggers_count ?? 0;
      if (eventCount > 0 && !hidden.has(t.slug.toLowerCase())) apps.push({ app: t.slug, name: t.name, logo: t.meta?.logo ?? null, eventCount });
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name));
  },

  // A new connector holds an empty project slot until the person signs in; only then does it carry a Composio account id.
  connectionReady: (connection) => Boolean(str(connection.metadata.connected_account_id)),

  async subscribe({ connection, type, config: triggerConfig }) {
    const connectedAccountId = str(connection.metadata.connected_account_id);
    if (!connectedAccountId) {
      throw new EventConnectionNotReadyError(`Finish connecting the shared ${connection.app} account to activate this trigger.`);
    }
    try {
      const res = await triggers().create(composioUserId(connection.connectionId), type, { connectedAccountId, triggerConfig });
      return { externalId: res.triggerId };
    } catch (error) {
      throw new Error(composioErrorMessage(error));
    }
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
      case 'composio.connected_account.activated': {
        // The account's user id is `kortix-connection:<connection_id>` (composioUserId).
        // Its place in the payload is undocumented, so find it anywhere, else read the account.
        const accountId = str(meta.connected_account_id) || str(data.connected_account_id) || str(data.id);
        const connectionId = kortixConnectionIn(body) ?? (accountId ? await connectionOfAccount(accountId) : null);
        if (connectionId) notices.push({ kind: 'connection_activated', connectionId });
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
