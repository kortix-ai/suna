/** The app events a project connector can trigger on, from its provider's catalog. */
import { connectorConnections, connectors, projects } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { defaultConnectionIdForConnector } from '../../connectors/credentials';
import { logger } from '../../lib/logger';
import { loadConnectionAudience } from '../lib/connection-audience';
import { db } from '../../shared/db';
import { RESERVED_CONNECTOR_SLUGS } from '../connectors';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { eventConfigProblem } from './config-validation';
import { connectorInfo } from './deliver';
import { MCP_APPS } from '../../connectors/mcp-apps';
import { MCP_SOURCE_ID, connectorEventApp, projectConnectorsOfApp } from './mcp-source';
import { allEventSources, eventSourceAvailable, eventSourceFor, unknownSourceMessage } from './registry';
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
  | { kind: 'app_not_found' }
  | { kind: 'unavailable' }
  | { kind: 'provider_error'; message: string };

async function projectMetadataOf(projectId: string): Promise<unknown> {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return row?.metadata ?? null;
}

/**
 * One adapter's events for one app, through the shared cache. No connector
 * needed. With a project in view, the source must be available to it, and an
 * adapter with per-connector types adds those of the project's first
 * connector for the app.
 */
export async function listAppEventTypes(
  source: string,
  app: string,
  scope?: { projectId: string; metadata?: unknown },
): Promise<EventTypeCatalog> {
  const provider = eventSourceFor(source);
  if (!provider || !provider.configured() || !app) return { kind: 'unavailable' };
  const metadata = scope ? (scope.metadata !== undefined ? scope.metadata : await projectMetadataOf(scope.projectId)) : undefined;
  if (!eventSourceAvailable(provider.id, metadata)) return { kind: 'unavailable' };
  let items: EventTypeInfo[];
  if (provider.id === MCP_SOURCE_ID) {
    // Kortix's own types are static code: nothing to cache, and no cache entry per probed app name.
    items = await provider.listEventTypes(app);
  } else {
    const key = `${provider.id}:${app}`;
    let cached = eventTypeCache.get(key);
    if (!cached || cached.expires < Date.now()) {
      try {
        cached = { expires: Date.now() + EVENT_TYPE_CACHE_MS, items: await provider.listEventTypes(app) };
      } catch (error) {
        return { kind: 'provider_error', message: error instanceof Error ? error.message : String(error) };
      }
      eventTypeCache.set(key, cached);
    }
    items = cached.items;
  }
  if (provider.id === MCP_SOURCE_ID && scope) {
    const [first] = await projectConnectorsOfApp(scope.projectId, app);
    if (first && provider.listConnectorEventTypes) items = await provider.listConnectorEventTypes({ connectorId: first.connectorId, app });
    // A catalogue app or a project MCP server has events once it is connected: an empty list, not "no such app".
    if (items.length === 0 && (first || MCP_APPS.some((a) => a.slug === app))) return { kind: 'ok', provider: provider.id, app, items };
  }
  // An app the adapter offers no event for is not an event app.
  if (items.length === 0) return { kind: 'app_not_found' };
  return { kind: 'ok', provider: provider.id, app, items };
}

export async function listConnectorEventTypes(
  projectId: string,
  connectorSlug: string,
  source?: string | null,
  projectMetadata?: unknown,
): Promise<EventTypeCatalog> {
  const metadata = projectMetadata !== undefined ? projectMetadata : await projectMetadataOf(projectId);
  const connector = await connectorInfo(projectId, connectorSlug, metadata);
  if (!connector.found) return { kind: 'connector_not_found' };
  // A source that is not the connector's provider has no catalog here: the reconciler reports the mismatch.
  if (source && source !== connector.provider) return { kind: 'unavailable' };
  if (!connector.app) return { kind: 'unavailable' };
  const provider = eventSourceFor(connector.provider);
  if (provider?.listConnectorEventTypes && connector.connectorId) {
    if (!provider.configured() || !eventSourceAvailable(provider.id, metadata)) return { kind: 'unavailable' };
    try {
      const items = await provider.listConnectorEventTypes({ connectorId: connector.connectorId, app: connector.app });
      return { kind: 'ok', provider: provider.id, app: connector.app, items };
    } catch (error) {
      return { kind: 'provider_error', message: error instanceof Error ? error.message : String(error) };
    }
  }
  const catalog = await listAppEventTypes(connector.provider, connector.app);
  // A connector whose app has no events keeps answering with an empty list.
  return catalog.kind === 'app_not_found' ? { kind: 'ok', provider: connector.provider, app: connector.app, items: [] } : catalog;
}

/** A trigger's event and config problem, or null. Skips when the catalog cannot answer: the reconciler still reports. */
export async function validateEventTrigger(
  projectId: string,
  event: { connector: string; source?: string | null; type: string; config: Record<string, unknown> },
): Promise<string | null> {
  const metadata = await projectMetadataOf(projectId);
  if (event.source) {
    const unknown = unknownSourceMessage(event.source, metadata);
    if (unknown) return unknown;
  }
  const catalog = await listConnectorEventTypes(projectId, event.connector, event.source, metadata);
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
  /** Source `mcp`: the catalogue MCP server to install for this app. Null otherwise. */
  mcpUrl: string | null;
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
  provider: { connectionReady?: (c: { connectionId: string; connectorSlug: string; app: string; metadata: Record<string, unknown> }) => boolean | Promise<boolean> },
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
      accounts: await Promise.all(accounts
        .filter((a) => a.connectorId === row.connectorId && audience(a.connectionId) === 'open')
        .map(async (a) => ({
          label: a.label,
          connectedAs: connectionIdentity(a) === a.label ? null : connectionIdentity(a),
          isDefault: a.connectionId === defaultId,
          connected: provider.connectionReady
            ? await provider.connectionReady({ connectionId: a.connectionId, connectorSlug: row.slug, app, metadata: a.metadata })
            : true,
        }))),
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
  const metadata = await projectMetadataOf(projectId);
  // connectors_v2 installs apps from the Kortix MCP catalog: a Composio app stays listed only where the project has one.
  const catalogOnly = resolveFeatureFlag(metadata, 'connectors_v2');
  const out: EventAppEntry[] = [];
  for (const provider of allEventSources(metadata)) {
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
    let items = cached.items;
    if (provider.id === MCP_SOURCE_ID) {
      // A project's own MCP server (outside the catalog) is an event app too: its tools are its events.
      const listed = new Set(items.map((i) => i.app));
      const custom = rows.filter((r) => r.provider === MCP_SOURCE_ID && !listed.has(connectorEventApp(r) ?? '') && connectorEventApp(r) === r.slug);
      items = [...items, ...custom.map((r) => ({ app: r.slug, name: r.name?.trim() || r.slug, logo: null, eventCount: 0 }))];
    }
    for (const item of items) {
      const profiles = rows.filter((r) => r.provider === provider.id && connectorEventApp(r) === item.app);
      const row = profiles[0];
      if (catalogOnly && provider.id !== MCP_SOURCE_ID && !row) continue;
      const eventCount = provider.id === MCP_SOURCE_ID && row && provider.listConnectorEventTypes
        ? (await provider.listConnectorEventTypes({ connectorId: row.connectorId, app: item.app })).length
        : item.eventCount;
      const resolved = row ? await resolveSource(projectId, accountId, { connector: row.slug, type: '', config: {} }, metadata) : null;
      const connected = resolved?.kind === 'ok';
      out.push({
        provider: provider.id,
        ...item,
        eventCount,
        connector: row?.slug ?? null,
        connected,
        connectors: await loadSharedAccounts(projectId, accountId, profiles, provider, item.app),
        newConnectorSlug: freeConnectorSlug(item.app, rows.map((r) => r.slug)),
        mcpUrl: provider.id === MCP_SOURCE_ID ? (MCP_APPS.find((a) => a.slug === item.app)?.url ?? null) : null,
      });
    }
  }
  return out;
}
