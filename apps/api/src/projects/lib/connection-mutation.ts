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
import { loadProjectForUser, projectCapabilityAllowed } from './access';
import {
  type ConnectionReachabilityActor,
  type ConnectionReachabilityRow,
  connectionRowIsReachable,
} from './connection-access';
import { requestAgentPrincipalReach } from './personal-resources';

export interface ConnectionMutationActor extends ConnectionReachabilityActor {
  /** The caller holds `project.connector.connections.manage`. */
  mayManageSystemConnections: boolean;
}

/**
 * The caller must reach the connection (`connectionRowIsReachable`). Your own
 * private account is then yours to administer: reachability already proved
 * the owner is the caller. Every other reachable connection is shared with
 * the project, so it needs the connections-manage capability.
 *
 * Mutating a shared account manages it; it does not use it. The account's
 * audience (who may USE it) is therefore `'open'` here: a connections manager
 * outside a narrowed account's audience still renames, re-credentials, or
 * revokes it.
 */
export function mayMutateConnection(
  connection: ConnectionReachabilityRow,
  actor: ConnectionMutationActor,
): boolean {
  return (
    connectionRowIsReachable(connection, actor, 'open') &&
    (connection.ownerType === 'member' || actor.mayManageSystemConnections)
  );
}

/**
 * The project and the connection the caller may mutate, or `null`. The
 * project load needs only `read`: the mutation rule above is the gate. Callers
 * answer `null` with 404, so a caller cannot probe for connections they cannot
 * reach.
 */
export async function loadMutableConnection(c: Context, projectId: string, connectionId: string) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return null;
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
  return mayMutateConnection(connection, actor) ? { loaded, connection } : null;
}
