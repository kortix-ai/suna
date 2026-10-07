/**
 * Event-subscription reconciler: makes the provider subscriptions match the
 * project's declared, enabled `event` triggers. Idempotent and safe to call
 * often (trigger CRUD, connector sync, connection changes). Never throws.
 */
import { connectorConnections, connectors, projectTriggerRuntime } from '@kortix/db';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { defaultConnectionIdForConnector } from '../../connectors/credentials';
import { logger } from '../../lib/logger';
import { connectionRowIsReachable } from '../lib/connection-access';
import { loadConnectionAudience } from '../lib/connection-audience';
import type { GitTriggerSpec } from '../trigger-types';
import { db } from '../../shared/db';
import { eventSourceFor } from './registry';
import * as store from './store';
import { EventConnectionNotReadyError, type EventSourceConnection, type EventSourceProvider } from './types';

type Resolution =
  | { kind: 'ok'; provider: EventSourceProvider; connection: EventSourceConnection }
  | { kind: 'needs_connection'; message: string }
  | { kind: 'error'; message: string };

/** Key-sorted JSON, so equal configs hash equal whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function desiredHash(
  provider: string,
  connectionId: string | null,
  eventType: string,
  config: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonicalJson([provider, connectionId ?? '', eventType, config]))
    .digest('hex');
}

/** Provider messages reach the UI: one line, bounded. */
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 500);

export async function resolveSource(
  projectId: string,
  accountId: string,
  event: NonNullable<GitTriggerSpec['event']>,
): Promise<Resolution & { providerId?: string }> {
  const [connector] = await db
    .select({
      connectorId: connectors.connectorId,
      provider: connectors.providerType,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, event.connector)))
    .limit(1);
  if (!connector) {
    return { kind: 'error', message: `Connector "${event.connector}" is not declared in kortix.yaml. Add it under \`connectors:\`.` };
  }
  const provider = eventSourceFor(connector.provider);
  if (!provider) {
    return { kind: 'error', message: `Connector "${event.connector}" (${connector.provider}) has no app-event source. Use an app connector.` };
  }
  if (!provider.configured()) {
    return { kind: 'error', message: 'Event triggers need COMPOSIO_API_KEY on this deployment.', providerId: provider.id };
  }
  const app = (connector.config as Record<string, unknown> | null)?.app;
  if (typeof app !== 'string' || !app) {
    return { kind: 'error', message: `Connector "${event.connector}" does not name an app.`, providerId: provider.id };
  }
  const needs: Resolution = {
    kind: 'needs_connection',
    message: `Connect a shared ${app} account to activate this trigger.`,
  };
  // A trigger is unattended: it runs on the project's shared default account,
  // never a member's private one (connection-access.ts).
  const connectionId = await defaultConnectionIdForConnector(connector.connectorId);
  if (!connectionId) return { ...needs, providerId: provider.id };
  const [row] = await db
    .select({
      ownerType: connectorConnections.ownerType,
      ownerId: connectorConnections.ownerId,
      status: connectorConnections.status,
      metadata: connectorConnections.metadata,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId))
    .limit(1);
  // Event data lands in a session prompt. An account narrowed to named people
  // must not feed it, so only an account open to the whole project qualifies.
  const audience = (await loadConnectionAudience({ projectId, accountId, userId: null }))(connectionId);
  if (row && row.status === 'active' && audience !== 'open') {
    return {
      kind: 'error',
      providerId: provider.id,
      message: `This ${app} account is shared with specific people only. Event triggers need an account shared with the whole project.`,
    };
  }
  if (
    !row ||
    row.status !== 'active' ||
    !connectionRowIsReachable(
      { ...row, providerType: connector.provider, connectorConfig: connector.config },
      { userId: '', isServiceAccount: true, agentPrincipal: null },
      audience,
    )
  ) {
    return { ...needs, providerId: provider.id };
  }
  return {
    kind: 'ok',
    providerId: provider.id,
    provider,
    connection: { connectionId, connectorSlug: event.connector, app, metadata: row.metadata },
  };
}

async function unsubscribeIfUnreferenced(
  provider: EventSourceProvider,
  externalId: string,
): Promise<void> {
  if ((await store.countByExternalId(provider.id, externalId)) === 0) {
    await provider.unsubscribe(externalId);
  }
}

async function reconcileOne(
  projectId: string,
  accountId: string,
  spec: GitTriggerSpec,
  prev: store.EventSubscriptionRow | undefined,
): Promise<void> {
  const event = spec.event!;
  const resolved = await resolveSource(projectId, accountId, event);
  const providerId = resolved.providerId ?? prev?.provider ?? 'composio';
  const base = {
    projectId,
    slug: spec.slug,
    accountId,
    provider: providerId,
    eventType: event.type,
  };
  if (resolved.kind !== 'ok') {
    // The account can no longer feed this trigger: drop the row's instance first,
    // so no delivery outlives the access that allowed it.
    await store.upsert({
      ...base,
      connectionId: null,
      externalId: null,
      desiredHash: desiredHash(providerId, null, event.type, event.config),
      status: resolved.kind,
      lastError: resolved.message,
    });
    const provider = eventSourceFor(providerId);
    if (provider && prev?.externalId) await unsubscribeIfUnreferenced(provider, prev.externalId);
    return;
  }
  const { provider, connection } = resolved;
  const hash = desiredHash(provider.id, connection.connectionId, event.type, event.config);
  if (prev && prev.status === 'active' && prev.desiredHash === hash) return;
  try {
    const { externalId } = await provider.subscribe({ connection, type: event.type, config: event.config });
    await store.upsert({
      ...base,
      connectionId: connection.connectionId,
      externalId,
      desiredHash: hash,
      status: 'active',
      lastError: null,
    });
    if (prev?.externalId && prev.externalId !== externalId) {
      await unsubscribeIfUnreferenced(provider, prev.externalId);
    }
  } catch (error) {
    await store.upsert({
      ...base,
      connectionId: connection.connectionId,
      externalId: prev?.externalId ?? null,
      desiredHash: hash,
      status: error instanceof EventConnectionNotReadyError ? 'needs_connection' : 'error',
      lastError: errorText(error),
    });
  }
}

async function removeStale(row: store.EventSubscriptionRow): Promise<void> {
  const provider = eventSourceFor(row.provider);
  if (provider && row.externalId && (await store.countByExternalId(row.provider, row.externalId)) <= 1) {
    await provider.unsubscribe(row.externalId);
  }
  await store.deleteRow(row.projectId, row.slug);
}

export async function reconcileEventSubscriptions(
  projectId: string,
  accountId: string,
  specs: readonly GitTriggerSpec[],
): Promise<void> {
  try {
    await store.withProjectEventLock(projectId, async () => {
      const desired = specs.filter((s) => s.type === 'event' && s.enabled && s.event);
      const desiredSlugs = new Set(desired.map((s) => s.slug));
      const rows = new Map((await store.listByProject(projectId)).map((r) => [r.slug, r]));
      for (const spec of desired) {
        try {
          await reconcileOne(projectId, accountId, spec, rows.get(spec.slug));
        } catch (error) {
          logger.warn('[trigger-events] reconcile failed', { projectId, slug: spec.slug, error: errorText(error) });
        }
      }
      for (const row of rows.values()) {
        if (desiredSlugs.has(row.slug)) continue;
        try {
          await removeStale(row);
        } catch (error) {
          // Row stays; the next reconcile retries the unsubscribe.
          logger.warn('[trigger-events] unsubscribe failed', { projectId, slug: row.slug, error: errorText(error) });
        }
      }
    });
  } catch (error) {
    logger.warn('[trigger-events] reconcile aborted', { projectId, error: errorText(error) });
  }
}

/**
 * Reconcile from the cataloged specs (`project_trigger_runtime.schedule_spec`, no git read).
 * For paths that change a connection, not the manifest: connect, finalize, revoke, default.
 */
export async function reconcileEventSubscriptionsFromCatalog(projectId: string, accountId: string): Promise<void> {
  try {
    const rows = await db
      .select({ spec: projectTriggerRuntime.scheduleSpec })
      .from(projectTriggerRuntime)
      .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.triggerType, 'event')));
    await reconcileEventSubscriptions(projectId, accountId, rows.map((r) => r.spec as unknown as GitTriggerSpec));
  } catch (error) {
    logger.warn('[trigger-events] catalog reconcile failed', { projectId, error: errorText(error) });
  }
}

/**
 * A project is leaving (archive, account deletion): unsubscribe every provider
 * instance it holds and drop its rows. Lock-free and best-effort per row, so a
 * concurrent reconcile cannot make it skip the project. Never throws.
 */
export async function releaseProjectEventSubscriptions(projectId: string): Promise<void> {
  try {
    for (const row of await store.listByProject(projectId)) {
      try {
        await removeStale(row);
      } catch (error) {
        logger.warn('[trigger-events] release failed', { projectId, slug: row.slug, error: errorText(error) });
      }
    }
  } catch (error) {
    logger.warn('[trigger-events] release aborted', { projectId, error: errorText(error) });
  }
}
