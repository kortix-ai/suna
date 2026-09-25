/**
 * ONE mutation rule for a connector connection. Every route that changes a
 * connection (label, credential, revoke, activate, default, connect, OAuth2
 * setup) loads it through `loadMutableConnection`.
 */
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam';
import { db } from '../../shared/db';
import { type loadProjectForUser, projectCapabilityAllowed } from './access';
import {
  type ConnectionOwnerType,
  connectionIsReachable,
  isTrustedManagedChannelAuthorization,
} from './connection-access';
import { requestAgentPrincipalReach } from './personal-resources';

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

export interface ConnectionMutationActor {
  userId: string;
  isServiceAccount: boolean;
  /** The caller holds `project.connector.connections.manage`. */
  mayManageSystemConnections: boolean;
  /** Agent-principal reach (spec 2026-09-22 §2.3); null = legacy rule. */
  agentPrincipal: Awaited<ReturnType<typeof requestAgentPrincipalReach>>;
}

/**
 * The caller must reach the connection (`connectionIsReachable`). Your own
 * private account is then yours to administer: reachability already proved
 * the owner is the caller. Every other reachable connection is shared with
 * the project, so it needs the connections-manage capability.
 */
export function mayMutateConnection(
  connection: {
    ownerType: ConnectionOwnerType;
    ownerId: string | null;
    metadata: Record<string, unknown>;
    providerType: string;
    connectorConfig: Record<string, unknown>;
  },
  actor: ConnectionMutationActor,
): boolean {
  const reachable = connectionIsReachable({
    ownerType: connection.ownerType,
    ownerId: connection.ownerId,
    actingUserId: actor.userId,
    actingPrincipalIsServiceAccount: actor.isServiceAccount,
    agentPrincipal: actor.agentPrincipal,
    trustedManagedSystem: isTrustedManagedChannelAuthorization({
      providerType: connection.providerType,
      platform:
        typeof connection.connectorConfig.platform === 'string'
          ? connection.connectorConfig.platform
          : null,
      ownerType: connection.ownerType,
      ownerId: connection.ownerId,
      metadata: connection.metadata,
    }),
  });
  return reachable && (connection.ownerType === 'member' || actor.mayManageSystemConnections);
}

/**
 * The connection the caller may mutate, or `null`. Callers answer `null` with
 * 404, so a caller cannot probe for connections they cannot reach.
 */
export async function loadMutableConnection(
  c: Context,
  loaded: LoadedProject,
  projectId: string,
  connectionId: string,
) {
  const [connection] = await db
    .select({
      accountId: connectorConnections.accountId,
      projectId: connectorConnections.projectId,
      connectorId: connectorConnections.connectorId,
      connectionId: connectorConnections.connectionId,
      ownerType: connectorConnections.ownerType,
      ownerId: connectorConnections.ownerId,
      isDefault: connectorConnections.isDefault,
      label: connectorConnections.label,
      status: connectorConnections.status,
      metadata: connectorConnections.metadata,
      providerType: connectors.providerType,
      connectorConfig: connectors.config,
      connectorAlias: connectors.slug,
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
        eq(connectorConnections.connectionId, connectionId),
        eq(connectorConnections.projectId, projectId),
        eq(connectorConnections.accountId, loaded.row.accountId),
      ),
    )
    .limit(1);
  if (!connection) return null;
  const [mayManageSystemConnections, agentPrincipal] = await Promise.all([
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
    ),
    requestAgentPrincipalReach(c, loaded.actor),
  ]);
  const actor = {
    userId: loaded.userId,
    isServiceAccount: c.get('authType') === 'service_account',
    mayManageSystemConnections,
    agentPrincipal,
  };
  return mayMutateConnection(connection, actor) ? connection : null;
}
