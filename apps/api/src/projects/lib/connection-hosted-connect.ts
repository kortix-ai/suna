import { connectorConnections } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import {
  composioConnectUrl,
  finalizeComposioConnection,
  composioUserId,
  probeComposioIdentity,
} from '../../connectors/composio';
import { connectedAsOf, relabelToIdentity, resolveConnectedAs } from '../../connectors/connection-identity';
import { composioConnectionMetadata } from '../../connectors/db-deps';
import { finalizePipedreamConnectionAuthorization, pipedreamConnectUrl } from '../../connectors/pipedream';
import { db } from '../../shared/db';
import { completeConnection, connectConnection } from '../../connectors/connection-status';

type Connection = NonNullable<Awaited<ReturnType<typeof import('./connection-mutation').loadMutableConnection>>>['connection'];

export function parseRedirects(body: Record<string, unknown>) {
  return body.success_redirect_uri || body.error_redirect_uri
    ? {
        success: typeof body.success_redirect_uri === 'string' ? body.success_redirect_uri : undefined,
        error: typeof body.error_redirect_uri === 'string' ? body.error_redirect_uri : undefined,
      }
    : undefined;
}

export async function startComposioConnect(projectId: string, connectionId: string, connection: Connection, app: string, body: Record<string, unknown>) {
  const stableUserId = composioUserId(connectionId);
  const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
  const result = await composioConnectUrl({
    projectId, slug: connection.connectorAlias, app, connectionId, stableUserId,
    redirects: parseRedirects(body),
  });
  // Starting an authorization is not a reconnect: an agent session may start
  // its own (`owner: "me"`), so leaving `revoked` stays a person's call. The
  // default `agent` authority keeps it (`connectors/connection-status.ts`).
  await connectConnection(connectionId, {
    metadata: composioConnectionMetadata({
      toolkit: app, stableUserId, sessionId: result.sessionId,
      authRequestId: result.authRequestId, connectedAccountId: result.connectedAccountId,
      isNoAuth: result.isNoAuth, previous: metadata,
      connectedAs: result.connectedAccountId && result.connectedAccountId === metadata.connected_account_id
        ? connectedAsOf(metadata) : null,
    }),
  });
  return { app, connectUrl: result.connectUrl, connected: result.connected, isNoAuth: result.isNoAuth };
}

export async function finalizeComposioConnect(projectId: string, connectionId: string, connection: Connection, app: string) {
  const stableUserId = composioUserId(connectionId);
  const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
  const sessionId = typeof metadata.session_id === 'string' ? metadata.session_id : '';
  if (!sessionId) return { connected: false };
  const result = await finalizeComposioConnection({
    projectId, slug: connection.connectorAlias, app, connectionId, stableUserId, sessionId,
    ...(typeof metadata.auth_request_id === 'string' ? { authRequestId: metadata.auth_request_id } : {}),
  });
  const connectedAs = result.connected
    ? await resolveConnectedAs({
        previous: metadata, connectedAccountId: result.connectedAccountId, isNoAuth: result.isNoAuth,
        probe: () => probeComposioIdentity({ app, sessionId: result.sessionId, connectedAccountId: result.connectedAccountId! }),
      }) : null;
  // An in-flight completion: a revoke that landed while the person was
  // signing in wins, and the account stays revoked.
  const live = await completeConnection(connectionId, null, {
    metadata: composioConnectionMetadata({
      toolkit: app, stableUserId, sessionId: result.sessionId,
      authRequestId: result.authRequestId, connectedAccountId: result.connectedAccountId,
      isNoAuth: result.isNoAuth, previous: metadata, connectedAs,
    }),
  });
  if (!live) return { connected: false };
  const label = connectedAs ? await relabelToIdentity({ connectionId, identity: connectedAs }) : null;
  return {
    connected: result.connected, accountId: result.connectedAccountId,
    connected_as: connectedAs, ...(label ? { label } : {}),
  };
}

export async function startPipedreamConnect(projectId: string, connectionId: string, connection: Connection, app: string, body: Record<string, unknown>) {
  const result = await pipedreamConnectUrl(projectId, connection.connectorAlias, app, connectionId, parseRedirects(body));
  return { token: result.token, app, connectUrl: result.connectUrl, expiresAt: result.expiresAt };
}

export async function finalizePipedreamConnect(projectId: string, connectionId: string, connection: Connection, app: string, createdBy: string) {
  return finalizePipedreamConnectionAuthorization({
    projectId, slug: connection.connectorAlias, app,
    connectorId: connection.connectorId, connectionId, createdBy,
  });
}
