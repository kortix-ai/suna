/**
 * ONE mutation rule for a connector connection. Every route that changes a
 * connection (label, credential, revoke, activate, default, connect, OAuth2
 * setup) loads it through `loadMutableConnection`.
 */
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  type ConnectionReachabilityActor,
  type ConnectionReachabilityRow,
  connectionRowIsReachable,
} from './connection-access';

// The request gate `loadMutableConnection` lives in
// `http-connection-mutation.ts`. Re-exported here so every importer keeps working.
export { loadMutableConnection } from './http-connection-mutation';

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

/** The connection row (with its connector's type, config and alias) in this project and account, or null. */
export async function loadConnectionForMutation(projectId: string, connectionId: string, accountId: string) {
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
        eq(connectorConnections.accountId, accountId),
      ),
    )
    .limit(1);
  return connection ?? null;
}
