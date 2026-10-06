import {
  type SessionConnectorBindings,
  SessionConnectorBindingsInputSchema,
} from '@kortix/api-contract';
import {
  connectorConnections,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
} from '@kortix/db';
import { and, eq, or, sql } from 'drizzle-orm';
import { canonicalConnectorAlias } from '../../shared/connector-alias';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import { connectionNeedsPrivateSession } from './connection-access';
import { audiencePersonId, loadConnectionAudience } from './connection-audience';
import {
  type ConnectorConnectionRow,
  type ConnectorRequirementRow,
  type ValidatedSessionConnectorBinding,
  connectorConnectionIsConnected,
  sessionConnectionIsReachable,
} from './connector-binding-shared';

export async function loadEmailInstallConnectionId(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      connectionId: connectorConnections.connectionId,
      metadata: connectorConnections.metadata,
      status: connectorConnections.status,
    })
    .from(connectorConnections)
    .innerJoin(
      connectors,
      eq(connectors.connectorId, connectorConnections.connectorId),
    )
    .where(
      and(
        eq(connectorConnections.projectId, projectId),
        eq(connectors.slug, canonicalConnectorAlias('email')),
      ),
    );
  return (
    rows.find(
      (row) =>
        row.status === 'active' && (row.metadata as Record<string, unknown>)?.inbox_id === inboxId,
    )?.connectionId ?? null
  );
}

export async function ensureEmailSessionBinding(input: {
  projectId: string;
  sessionId: string;
  inboxId: string;
}): Promise<boolean> {
  const connectionId = await loadEmailInstallConnectionId(input.projectId, input.inboxId);
  if (!connectionId) return false;
  const [connection] = await db
    .select({
      accountId: connectorConnections.accountId,
      connectorId: connectorConnections.connectorId,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId))
    .limit(1);
  const [session] = await db
    .select({ accountId: projectSessions.accountId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!connection || !session || connection.accountId !== session.accountId) return false;
  try {
    await db.insert(projectSessionConnectorBindings).values({
      sessionId: input.sessionId,
      accountId: session.accountId,
      projectId: input.projectId,
      connectorAlias: canonicalConnectorAlias('email'),
      connectorId: connection.connectorId,
      connectionId,
      source: 'default',
      createdBy: null,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const [binding] = await db
    .select({ connectionId: projectSessionConnectorBindings.connectionId })
    .from(projectSessionConnectorBindings)
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, input.sessionId),
        eq(projectSessionConnectorBindings.connectorAlias, canonicalConnectorAlias('email')),
      ),
    )
    .limit(1);
  return binding?.connectionId === connectionId;
}

export function parseSessionConnectorBindings(
  value: unknown,
): { ok: true; bindings: SessionConnectorBindings | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, bindings: undefined };
  const parsed = SessionConnectorBindingsInputSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, bindings: parsed.data };
}

export async function validateSessionConnectorBindings(input: {
  accountId: string;
  projectId: string;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  /** @deprecated Authorization strategy is the only owner gate. */
  mayManageSystemConnections: boolean;
  bindings: SessionConnectorBindings | undefined;
}): Promise<
  | { ok: true; bindings: ValidatedSessionConnectorBinding[] }
  | { ok: false; error: string; code: string }
> {
  if (!input.bindings) return { ok: true, bindings: [] };

  const audienceOf = await loadConnectionAudience({
    projectId: input.projectId,
    accountId: input.accountId,
    userId: audiencePersonId(input),
  });
  const validated: ValidatedSessionConnectorBinding[] = [];
  for (const [requestedAlias, binding] of Object.entries(input.bindings)) {
    const alias = canonicalConnectorAlias(requestedAlias);
    const [row] = await db
      .select({
        connectionId: connectorConnections.connectionId,
        connectorId: connectorConnections.connectorId,
        ownerType: connectorConnections.ownerType,
        ownerId: connectorConnections.ownerId,
        isDefault: connectorConnections.isDefault,
        status: connectorConnections.status,
        metadata: connectorConnections.metadata,
        connectorEnabled: connectors.enabled,
        connectorStatus: connectors.status,
        connectorName: connectors.name,
        providerType: connectors.providerType,
        connectorConfig: connectors.config,
      })
      .from(connectorConnections)
      .innerJoin(
        connectors,
        and(
          eq(connectors.connectorId, connectorConnections.connectorId),
          eq(connectors.accountId, connectorConnections.accountId),
          eq(connectors.projectId, connectorConnections.projectId),
        ),
      )
      .where(
        and(
          eq(connectorConnections.connectionId, binding.connection_id),
          eq(connectorConnections.accountId, input.accountId),
          eq(connectorConnections.projectId, input.projectId),
          eq(connectors.slug, alias),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        ok: false,
        error: `Connection is not available for connector alias "${alias}" in this project`,
        code: 'CONNECTOR_CONNECTION_NOT_FOUND',
      };
    }
    const connector: ConnectorRequirementRow = {
      connectorId: row.connectorId,
      projectId: input.projectId,
      slug: alias,
      name: row.connectorName,
      providerType: row.providerType,
      config: row.connectorConfig,
      enabled: row.connectorEnabled,
      status: row.connectorStatus,
    };
    const connection: ConnectorConnectionRow = {
      connectionId: row.connectionId,
      isDefault: row.isDefault,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      status: row.status,
      metadata: row.metadata,
    };
    const audience = audienceOf(row.connectionId);
    if (
      !sessionConnectionIsReachable(
        connector,
        connection,
        {
          userId: input.actingUserId,
          isServiceAccount: input.actingPrincipalIsServiceAccount,
          agentPrincipal: null,
        },
        audience,
      )
    ) {
      return {
        ok: false,
        error: `Connection is not available for connector alias "${alias}" in this project`,
        code: 'CONNECTOR_CONNECTION_NOT_FOUND',
      };
    }
    if (row.status !== 'active') {
      return {
        ok: false,
        error: `Connection for connector alias "${alias}" is not active`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    if (!row.connectorEnabled) {
      return {
        ok: false,
        error: `Connector for alias "${alias}" is disabled`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    if (row.connectorStatus !== 'active') {
      return {
        ok: false,
        error: `Connector for alias "${alias}" is not active`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    if (!(await connectorConnectionIsConnected({ connector, connection }))) {
      return {
        ok: false,
        error: `Connection for connector alias "${alias}" is not connected`,
        code: 'CONNECTOR_CONNECTION_INACTIVE',
      };
    }
    validated.push({
      alias,
      connectionId: row.connectionId,
      connectorId: row.connectorId,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      personal: connectionNeedsPrivateSession(row.ownerType, audience),
    });
  }
  return { ok: true, bindings: validated };
}

export function sessionConnectorBindingsRequirePrivateVisibility(
  bindings: readonly ValidatedSessionConnectorBinding[],
): boolean {
  return bindings.some((binding) => binding.personal);
}

/**
 * Does this session hold a personal binding — a private account, or a shared
 * one narrowed to an audience? Such a session cannot become shared: every
 * other viewer could then make the agent act as that account.
 *
 * "Narrowed" is read from the grant store in SQL (a live `connection` grant
 * and no grant to everyone), the same rule `audienceReachOf` applies.
 */
export async function sessionHasPersonalConnectorBinding(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ connectionId: projectSessionConnectorBindings.connectionId })
    .from(projectSessionConnectorBindings)
    .innerJoin(
      connectorConnections,
      eq(connectorConnections.connectionId, projectSessionConnectorBindings.connectionId),
    )
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, input.sessionId),
        eq(projectSessionConnectorBindings.accountId, input.accountId),
        eq(projectSessionConnectorBindings.projectId, input.projectId),
        or(
          eq(connectorConnections.ownerType, 'member'),
          and(
            eq(connectorConnections.ownerType, 'project'),
            narrowedSharedConnection,
            // Shared with this session's own agent: reachable whoever views the
            // session, so sharing the session hands no one a person's account.
            sql`not exists (
              select 1 from kortix.role_assignments ra
               where ${liveConnectionGrant} and ra.principal_type = 'service_account'
                 and ra.principal_id in (
                   select t.service_account_id from kortix.account_tokens t
                    where t.session_id = ${input.sessionId} and t.status = 'active'
                      and t.revoked_at is null and t.service_account_id is not null))`,
          ),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

const liveConnectionGrant = sql`
  ra.scope_type = 'project'
  and ra.scope_id = ${connectorConnections.projectId}
  and ra.object_type = 'connection'
  and ra.object_id = ${connectorConnections.connectionId}::text
  and (ra.expires_at is null or ra.expires_at > now())`;

/** A shared account with a live `connection` grant and none to everyone. */
const narrowedSharedConnection = sql`(
  exists (select 1 from kortix.role_assignments ra where ${liveConnectionGrant})
  and not exists (
    select 1 from kortix.role_assignments ra where ${liveConnectionGrant} and ra.principal_type = 'project'
  )
)`;
