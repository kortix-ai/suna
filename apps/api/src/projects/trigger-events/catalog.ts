/** The app events a project connector can trigger on, from its provider's catalog. */
import { connectors } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { eventConfigProblem } from './config-validation';
import { connectorInfo } from './deliver';
import { allEventSources, eventSourceFor } from './registry';
import { resolveSource } from './subscriptions';
import type { EventApp, EventTypeInfo } from './types';

/** Provider event catalogs change rarely and cost several provider calls. */
const EVENT_TYPE_CACHE_MS = 10 * 60_000;
// replica-local: a read-through cache of the provider's public catalog. Each
// replica fills its own copy; a miss costs one provider listing, never a wrong answer.
const eventTypeCache = new Map<string, { expires: number; items: EventTypeInfo[] }>();

export type EventTypeCatalog =
  | { kind: 'ok'; provider: string; app: string; items: EventTypeInfo[] }
  | { kind: 'connector_not_found' }
  | { kind: 'unavailable' }
  | { kind: 'provider_error'; message: string };

export async function listConnectorEventTypes(projectId: string, connectorSlug: string): Promise<EventTypeCatalog> {
  const connector = await connectorInfo(projectId, connectorSlug);
  if (!connector.found) return { kind: 'connector_not_found' };
  const provider = eventSourceFor(connector.provider);
  if (!provider || !provider.configured() || !connector.app) return { kind: 'unavailable' };
  const key = `${provider.id}:${connector.app}`;
  let cached = eventTypeCache.get(key);
  if (!cached || cached.expires < Date.now()) {
    try {
      cached = { expires: Date.now() + EVENT_TYPE_CACHE_MS, items: await provider.listEventTypes(connector.app) };
    } catch (error) {
      return { kind: 'provider_error', message: error instanceof Error ? error.message : String(error) };
    }
    eventTypeCache.set(key, cached);
  }
  return { kind: 'ok', provider: provider.id, app: connector.app, items: cached.items };
}

/** A trigger's event and config problem, or null. Skips when the catalog cannot answer: the reconciler still reports. */
export async function validateEventTrigger(
  projectId: string,
  event: { connector: string; type: string; config: Record<string, unknown> },
): Promise<string | null> {
  const catalog = await listConnectorEventTypes(projectId, event.connector);
  if (catalog.kind !== 'ok') return null;
  return eventConfigProblem(catalog.items, event.connector, event.type, event.config);
}

/** The app list changes when a provider adds an app. */
const EVENT_APP_CACHE_MS = 60 * 60_000;
// replica-local: read-through cache of each provider's public app list; a miss costs one provider listing.
const eventAppCache = new Map<string, { expires: number; items: EventApp[] }>();

export interface EventAppEntry {
  provider: string;
  app: string;
  name: string;
  logo: string | null;
  eventCount: number;
  /** Slug of the project's connector for this app. */
  connector: string | null;
  /** The project has an active account shared with the whole project: the one an event trigger runs on. */
  connected: boolean;
}

export async function listEventApps(projectId: string, accountId: string): Promise<EventAppEntry[]> {
  const rows = await db
    .select({ slug: connectors.slug, provider: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(eq(connectors.projectId, projectId));
  const out: EventAppEntry[] = [];
  for (const provider of allEventSources()) {
    if (!provider.configured()) continue;
    let cached = eventAppCache.get(provider.id);
    if (!cached || cached.expires < Date.now()) {
      try {
        cached = { expires: Date.now() + EVENT_APP_CACHE_MS, items: await provider.listApps() };
      } catch (error) {
        logger.warn('[trigger-events] app list failed', { provider: provider.id, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      eventAppCache.set(provider.id, cached);
    }
    for (const item of cached.items) {
      const row = rows.find((r) => r.provider === provider.id && (r.config as Record<string, unknown> | null)?.app === item.app);
      const connected = row
        ? (await resolveSource(projectId, accountId, { connector: row.slug, type: '', config: {} })).kind === 'ok'
        : false;
      out.push({ provider: provider.id, ...item, connector: row?.slug ?? null, connected });
    }
  }
  return out;
}
