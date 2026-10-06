import { type SessionConnectorBindings } from '@kortix/api-contract';
import {
  connectorConnections,
  connectors,
  projectSessionConnectorBindings,
} from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { mapLimit } from '@kortix/registry';
import {
  canonicalConnectorAlias,
  publicConnectorAlias,
} from '../../shared/connector-alias';
import { db } from '../../shared/db';
import { connectionNeedsPrivateSession } from './connection-access';
import { audiencePersonId, loadConnectionAudience } from './connection-audience';
import { sessionAgentId } from './secret-audience';
import {
  type ConnectorConnectionRow,
  type ConnectorRequirementRow,
  boundConnectionSelect,
  connectorConnectionIsConnected,
  sessionConnectionIsReachable,
} from './connector-binding-shared';
import { loadSessionConnectorLookup } from './connector-binding-resolve';
import {
  listEntitledConnectorConnectionsBatch,
  resolveEntitledTier,
} from './connector-binding-entitlement';
import { parseSessionConnectorBindings } from './connector-binding-validate';

/**
 * Return the authorization map that Connector resolves for the session now.
 *
 * A session without caller-configured bindings can use strategy-based defaults
 * without durable binding rows. Read-back must materialize those defaults.
 * Explicit-only sessions remain explicit-only because
 * `resolveSessionConnectorConnection` enforces the persisted inheritance state.
 *
 * Batched (2026-09-27). This answers, for every alias, exactly what
 * `resolveSessionConnectorConnection` answers for that alias alone, but reads
 * the session, the connector rows, the session's bindings and the candidate
 * connections once for all aliases. Resolving alias by alias cost 4-5 queries
 * per connector: `GET /sessions/:id/scope` measured `db n=55-64` and up to
 * 5 s on prod, on every session open. The per-alias resolver stays the
 * definition; `integration-session-scope-query-count.test.ts` asserts the two
 * agree across bound, revoked, inherited, fail-closed, ambiguous, pinned,
 * foreign-member and disabled connectors.
 */
export async function resolveEffectiveSessionConnectorBindings(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  grantedConnectors: string[] | 'all' | undefined;
}): Promise<SessionConnectorBindings> {
  const requestedAliases = Array.isArray(input.grantedConnectors)
    ? input.grantedConnectors
    : (
        await db
          .select({ alias: connectors.slug })
          .from(connectors)
          .where(
            and(
              eq(connectors.accountId, input.accountId),
              eq(connectors.projectId, input.projectId),
              eq(connectors.enabled, true),
              eq(connectors.status, 'active'),
            ),
          )
          .orderBy(connectors.slug)
      ).map((row) => row.alias);
  const uniqueAliases = [...new Set(requestedAliases.map((a) => canonicalConnectorAlias(a)))];
  if (uniqueAliases.length === 0) return {};

  const session = await loadSessionConnectorLookup(input.sessionId, input.accountId, input.projectId);
  if (!session) return {};
  const actingUserId = session.createdBy ?? '';
  const actingPrincipalIsServiceAccount = session.createdByServiceAccountId !== null;
  const visibility = session.visibility;
  const fallbackAllowed = !session.bindingsConfigured || session.inheritUnbound;

  const boundRows = await db
    .select({
      alias: projectSessionConnectorBindings.connectorAlias,
      ...boundConnectionSelect(),
    })
    .from(projectSessionConnectorBindings)
    .innerJoin(
      connectorConnections,
      eq(connectorConnections.connectionId, projectSessionConnectorBindings.connectionId),
    )
    .innerJoin(
      connectors,
      and(
        eq(connectors.connectorId, projectSessionConnectorBindings.connectorId),
        eq(connectors.accountId, projectSessionConnectorBindings.accountId),
        eq(connectors.projectId, projectSessionConnectorBindings.projectId),
      ),
    )
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, input.sessionId),
        eq(projectSessionConnectorBindings.accountId, input.accountId),
        eq(projectSessionConnectorBindings.projectId, input.projectId),
        inArray(projectSessionConnectorBindings.connectorAlias, uniqueAliases),
      ),
    );
  // The primary key is (session_id, connector_alias): at most one row per alias.
  const boundByAlias = new Map(boundRows.map((row) => [row.alias, row]));

  const resolved = new Map<string, string>();

  // A bound alias resolves to its pin or to nothing — never to a default.
  if (boundRows.length > 0) {
    const audienceOf = await loadConnectionAudience({
      projectId: input.projectId,
      accountId: input.accountId,
      userId: audiencePersonId({ actingUserId, actingPrincipalIsServiceAccount }),
      agentId: await sessionAgentId(input.sessionId),
    });
    const RESOLVE_CONCURRENCY = 8;
    await mapLimit(boundRows, RESOLVE_CONCURRENCY, async (bound) => {
      const connector: ConnectorRequirementRow = {
        connectorId: bound.connectorId,
        projectId: input.projectId,
        slug: bound.alias,
        name: bound.connectorName,
        providerType: bound.providerType,
        config: bound.connectorConfig,
        enabled: bound.connectorEnabled,
        status: bound.connectorStatus,
      };
      const connection: ConnectorConnectionRow = {
        connectionId: bound.connectionId,
        isDefault: bound.isDefault,
        ownerType: bound.ownerType,
        ownerId: bound.ownerId,
        status: bound.connectionStatus,
        metadata: bound.metadata,
      };
      const audience = audienceOf(connection.connectionId);
      if (
        !connector.enabled ||
        connector.status !== 'active' ||
        connection.status !== 'active' ||
        (connectionNeedsPrivateSession(connection.ownerType, audience) && visibility !== 'private') ||
        !sessionConnectionIsReachable(
          connector,
          connection,
          { userId: actingUserId, isServiceAccount: actingPrincipalIsServiceAccount, agentPrincipal: null },
          audience,
        ) ||
        !(await connectorConnectionIsConnected({ connector, connection }))
      ) {
        return;
      }
      resolved.set(bound.alias, bound.connectionId);
    });
  }

  // An unbound alias falls back to the project default unless the session
  // configured its bindings without inheriting.
  const unbound = uniqueAliases.filter((alias) => !boundByAlias.has(alias));
  if (fallbackAllowed && unbound.length > 0) {
    const connectorRows = await db
      .select({
        connectorId: connectors.connectorId,
        projectId: connectors.projectId,
        slug: connectors.slug,
        name: connectors.name,
        providerType: connectors.providerType,
        config: connectors.config,
        enabled: connectors.enabled,
        status: connectors.status,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.accountId, input.accountId),
          eq(connectors.projectId, input.projectId),
          inArray(connectors.slug, unbound),
        ),
      );
    const entitledByConnector = await listEntitledConnectorConnectionsBatch({
      accountId: input.accountId,
      projectId: input.projectId,
      connectors: connectorRows,
      actingUserId,
      actingPrincipalIsServiceAccount,
      visibility,
      agentPrincipal: null,
    });
    for (const connector of connectorRows) {
      const selection = resolveEntitledTier(entitledByConnector.get(connector.connectorId) ?? []);
      if (selection.kind === 'one') resolved.set(connector.slug, selection.connection.connectionId);
    }
  }

  const bindings: SessionConnectorBindings = {};
  for (const alias of uniqueAliases) {
    const connectionId = resolved.get(alias);
    if (connectionId) bindings[publicConnectorAlias(alias)] = { connection_id: connectionId };
  }
  return bindings;
}

function canonicalConnectorBindings(value: unknown): string {
  const parsed = parseSessionConnectorBindings(value);
  if (!parsed.ok || !parsed.bindings) return '{}';
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed.bindings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([alias, binding]) => [
          alias,
          { connection_id: binding.connection_id },
        ]),
    ),
  );
}

export function connectorBindingPayloadConflicts(existing: unknown, requested: unknown): boolean {
  return canonicalConnectorBindings(existing) !== canonicalConnectorBindings(requested);
}
