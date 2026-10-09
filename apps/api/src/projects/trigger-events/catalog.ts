/** The app events a project connector can trigger on, from its provider's catalog. */
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { defaultConnectionIdForConnector } from '../../connectors/credentials';
import { logger } from '../../lib/logger';
import { loadConnectionAudience } from '../lib/connection-audience';
import { db } from '../../shared/db';
import { RESERVED_CONNECTOR_SLUGS } from '../connectors';
import { eventConfigProblem } from './config-validation';
import { connectorInfo } from './deliver';
import { allEventSources, eventSourceFor, unknownSourceMessage } from './registry';
import { connectionIdentity, resolveSource } from './subscriptions';
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

export async function listConnectorEventTypes(projectId: string, connectorSlug: string, source?: string | null): Promise<EventTypeCatalog> {
  const connector = await connectorInfo(projectId, connectorSlug);
  if (!connector.found) return { kind: 'connector_not_found' };
  // A source that is not the connector's provider has no catalog here: the reconciler reports the mismatch.
  if (source && source !== connector.provider) return { kind: 'unavailable' };
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
  event: { connector: string; source?: string | null; type: string; config: Record<string, unknown> },
): Promise<string | null> {
  if (event.source) {
    const unknown = unknownSourceMessage(event.source);
    if (unknown) return unknown;
  }
  const catalog = await listConnectorEventTypes(projectId, event.connector, event.source);
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
  /** Every connector (profile) of this app with its shared accounts. */
  connectors: EventAppConnector[];
  /** Slug to give a new connector for this app: the app's own, unless reserved or taken. */
  newConnectorSlug: string;
}

export interface EventAppConnector {
  slug: string;
  name: string;
  accounts: { label: string; connectedAs: string | null; isDefault: boolean; connected: boolean }[];
}

/** Each connector's SHARED accounts: project-owned, active, open to the whole project. Only these can feed an event trigger. */
async function loadSharedAccounts(
  projectId: string,
  accountId: string,
  rows: { connectorId: string; slug: string; name: string | null; config: unknown; provider: string }[],
  provider: { connectionReady?: (c: { connectionId: string; connectorSlug: string; app: string; metadata: Record<string, unknown> }) => boolean },
  app: string,
): Promise<EventAppConnector[]> {
  if (rows.length === 0) return [];
  const accounts = await db
    .select({
      connectorId: connectorConnections.connectorId,
      connectionId: connectorConnections.connectionId,
      label: connectorConnections.label,
      metadata: connectorConnections.metadata,
    })
    .from(connectorConnections)
    .where(and(
      inArray(connectorConnections.connectorId, rows.map((r) => r.connectorId)),
      eq(connectorConnections.ownerType, 'project'),
      eq(connectorConnections.status, 'active'),
    ))
    .orderBy(connectorConnections.createdAt);
  const audience = await loadConnectionAudience({ projectId, accountId, userId: null });
  const out: EventAppConnector[] = [];
  for (const row of rows) {
    const defaultId = await defaultConnectionIdForConnector(row.connectorId);
    out.push({
      slug: row.slug,
      name: row.name?.trim() || app,
      accounts: accounts
        .filter((a) => a.connectorId === row.connectorId && audience(a.connectionId) === 'open')
        .map((a) => ({
          label: a.label,
          connectedAs: connectionIdentity(a) === a.label ? null : connectionIdentity(a),
          isDefault: a.connectionId === defaultId,
          connected: provider.connectionReady
            ? provider.connectionReady({ connectionId: a.connectionId, connectorSlug: row.slug, app, metadata: a.metadata })
            : true,
        })),
    });
  }
  return out;
}

/** `slack` is the built-in channel; a taken slug would update another connector. */
export function freeConnectorSlug(app: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!RESERVED_CONNECTOR_SLUGS.has(app) && !used.has(app)) return app;
  for (let n = 1; ; n++) {
    const slug = n === 1 ? `${app}-events` : `${app}-events-${n}`;
    if (!used.has(slug)) return slug;
  }
}

export async function listEventApps(projectId: string, accountId: string): Promise<EventAppEntry[]> {
  const rows = await db
    .select({ connectorId: connectors.connectorId, slug: connectors.slug, name: connectors.name, provider: connectors.providerType, config: connectors.config })
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
      const resolved = row ? await resolveSource(projectId, accountId, { connector: row.slug, type: '', config: {} }) : null;
      const connected = resolved?.kind === 'ok';
      const profiles = rows.filter((r) => r.provider === provider.id && (r.config as Record<string, unknown> | null)?.app === item.app);
      out.push({
        provider: provider.id,
        ...item,
        connector: row?.slug ?? null,
        connected,
        connectors: await loadSharedAccounts(projectId, accountId, profiles, provider, item.app),
        newConnectorSlug: freeConnectorSlug(item.app, rows.map((r) => r.slug)),
      });
    }
  }
  return out;
}
