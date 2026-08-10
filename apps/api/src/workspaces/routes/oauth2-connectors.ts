import {
  OAuth2ApplicationInputSchema,
  OAuth2AuthorizationStartInputSchema,
  OAuth2DeviceAuthorizationStartInputSchema,
  OAuth2DiscoveryInputSchema,
} from '@kortix/api-contract';
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import { ensureDefaultConnection } from '../../connectors/credentials';
import {
  createAuthorizationCodeSession,
  createDeviceAuthorizationSession,
  discoverConfiguredOAuth2Application,
  loadOAuth2Application,
  oauth2ConnectionStatus,
  pollDeviceAuthorizationSession,
  redactOAuth2Application,
  saveOAuth2Application,
} from '../../connectors/oauth2-store';
import { WORKSPACE_ACTIONS } from '../../iam';
import { db } from '../../shared/db';
import { loadWorkspaceForUser, workspaceCapabilityAllowed } from '../lib/access';
import { workspaceRoutesApp } from '../lib/app';
import {
  connectorAuthorizationMatchesStrategy,
  isTrustedManagedChannelAuthorization,
} from '../lib/connector-authorization-strategy';
import { readBody } from '../lib/serializers';

function callbackUrl(requestUrl: string): string {
  return new URL('/v1/connectors/oauth2/callback', requestUrl).href;
}

function allowedRedirectUri(value: string | undefined, workspaceId: string): string | undefined {
  if (!value) return undefined;
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('redirect URI is invalid');
  }
  const configuredOrigin = new URL(config.FRONTEND_URL).origin;
  const allowedOrigins = new Set([
    configuredOrigin,
    'https://kortix.com',
    'https://www.kortix.com',
    'https://dev.kortix.com',
    'https://staging.kortix.com',
  ]);
  if (!allowedOrigins.has(uri.origin)) throw new Error('redirect URI origin is not allowed');
  if (!uri.pathname.startsWith(`/projects/${workspaceId}`) && uri.origin !== configuredOrigin) {
    throw new Error('redirect URI path is not allowed');
  }
  return uri.href;
}

async function loadMutableConnection(c: any, workspaceId: string, connectionId: string) {
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return null;
  const [connection] = await db
    .select({
      accountId: connectorConnections.accountId,
      workspaceId: connectorConnections.workspaceId,
      connectorId: connectorConnections.connectorId,
      connectionId: connectorConnections.connectionId,
      ownerType: connectorConnections.ownerType,
      ownerId: connectorConnections.ownerId,
      metadata: connectorConnections.metadata,
      authorizationStrategy: connectors.authorizationStrategy,
      providerType: connectors.providerType,
      connectorConfig: connectors.config,
    })
    .from(connectorConnections)
    .innerJoin(
      connectors,
      and(
        eq(connectors.connectorId, connectorConnections.connectorId),
        eq(connectors.accountId, connectorConnections.accountId),
        eq(connectors.workspaceId, connectorConnections.workspaceId),
      ),
    )
    .where(
      and(
        eq(connectorConnections.connectionId, connectionId),
        eq(connectorConnections.workspaceId, workspaceId),
        eq(connectorConnections.accountId, loaded.row.accountId),
      ),
    )
    .limit(1);
  if (!connection) return null;
  const serviceAccount = c.get('authType') === 'service_account';
  const mayManage = await workspaceCapabilityAllowed(
    c,
    loaded.userId,
    loaded.row.accountId,
    workspaceId,
    WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_CONNECTIONS_MANAGE,
  );
  const strategyMatches = connectorAuthorizationMatchesStrategy({
    strategy: connection.authorizationStrategy,
    ownerType: connection.ownerType,
    ownerId: connection.ownerId,
    actingUserId: loaded.userId,
    actingPrincipalIsServiceAccount: serviceAccount,
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
  const allowed =
    strategyMatches && (connection.authorizationStrategy === 'user' || mayManage);
  return allowed ? { loaded, connection } : null;
}

workspaceRoutesApp.post('/:workspaceId/connectors/:slug/oauth2/connection', async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const slug = c.req.param('slug');
  const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const mayManage = await workspaceCapabilityAllowed(
    c,
    loaded.userId,
    loaded.row.accountId,
    workspaceId,
    WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_CONNECTIONS_MANAGE,
  );
  if (!mayManage) return c.json({ error: 'Forbidden' }, 403);
  const [connector] = await db
    .select({
      connectorId: connectors.connectorId,
      authorizationStrategy: connectors.authorizationStrategy,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.accountId, loaded.row.accountId),
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.slug, slug),
      ),
    )
    .limit(1);
  if (!connector) return c.json({ error: 'Connector not found' }, 404);
  if (connector.authorizationStrategy !== 'project') {
    return c.json(
      {
        error: 'This connector uses member-owned connections',
        code: 'CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH',
      },
      409,
    );
  }
  const connectionId = await ensureDefaultConnection({
    workspaceId,
    connectorId: connector.connectorId,
    createdBy: loaded.userId,
  });
  return c.json({ connection_id: connectionId });
});

workspaceRoutesApp.put('/:workspaceId/connections/:connectionId/oauth2/application', async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const connectionId = c.req.param('connectionId');
  const mutable = await loadMutableConnection(c, workspaceId, connectionId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const parsed = OAuth2ApplicationInputSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return c.json(
      {
        error: parsed.error.issues[0]?.message ?? 'invalid OAuth2 application',
      },
      400,
    );
  }
  await saveOAuth2Application(mutable.connection, parsed.data, mutable.loaded.userId);
  return c.json({ ok: true });
});

workspaceRoutesApp.get('/:workspaceId/connections/:connectionId/oauth2/application', async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const connectionId = c.req.param('connectionId');
  const mutable = await loadMutableConnection(c, workspaceId, connectionId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const loaded = await loadOAuth2Application(connectionId);
  if (!loaded) return c.json({ error: 'OAuth2 application is not configured' }, 404);
  return c.json({ application: redactOAuth2Application(loaded.application) });
});

workspaceRoutesApp.post('/:workspaceId/connections/:connectionId/oauth2/discover', async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const connectionId = c.req.param('connectionId');
  if (!(await loadMutableConnection(c, workspaceId, connectionId))) {
    return c.json({ error: 'Not found' }, 404);
  }
  const parsed = OAuth2DiscoveryInputSchema.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid discovery URL' }, 400);
  try {
    return c.json({
      metadata: await discoverConfiguredOAuth2Application(parsed.data.discovery_url),
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

workspaceRoutesApp.post('/:workspaceId/connections/:connectionId/oauth2/authorize', async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const connectionId = c.req.param('connectionId');
  const mutable = await loadMutableConnection(c, workspaceId, connectionId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const parsed = OAuth2AuthorizationStartInputSchema.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid authorization input' }, 400);
  try {
    const successRedirectUri = allowedRedirectUri(parsed.data.success_redirect_uri, workspaceId);
    const errorRedirectUri = allowedRedirectUri(parsed.data.error_redirect_uri, workspaceId);
    const started = await createAuthorizationCodeSession({
      connectionId,
      initiatedBy: mutable.loaded.userId,
      callbackUrl: callbackUrl(c.req.url),
      scopes: parsed.data.scopes,
      successRedirectUri,
      errorRedirectUri,
    });
    return c.json({
      authorization_url: started.authorizationUrl,
      expires_at: new Date(started.expiresAt).toISOString(),
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

workspaceRoutesApp.post('/:workspaceId/connections/:connectionId/oauth2/device', async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const connectionId = c.req.param('connectionId');
  const mutable = await loadMutableConnection(c, workspaceId, connectionId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const parsed = OAuth2DeviceAuthorizationStartInputSchema.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid device authorization input' }, 400);
  try {
    const started = await createDeviceAuthorizationSession({
      connectionId,
      initiatedBy: mutable.loaded.userId,
      scopes: parsed.data.scopes,
    });
    return c.json({
      session_id: started.sessionId,
      user_code: started.userCode,
      verification_uri: started.verificationUri,
      ...(started.verificationUriComplete
        ? { verification_uri_complete: started.verificationUriComplete }
        : {}),
      expires_at: new Date(started.expiresAt).toISOString(),
      interval_seconds: started.intervalSeconds,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

workspaceRoutesApp.post(
  '/:workspaceId/connections/:connectionId/oauth2/device/:sessionId',
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const connectionId = c.req.param('connectionId');
    const mutable = await loadMutableConnection(c, workspaceId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    try {
      return c.json(
        await pollDeviceAuthorizationSession({
          connectionId,
          sessionId: c.req.param('sessionId'),
          initiatedBy: mutable.loaded.userId,
        }),
      );
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  },
);

workspaceRoutesApp.get('/:workspaceId/connections/:connectionId/oauth2/status', async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const connectionId = c.req.param('connectionId');
  if (!(await loadMutableConnection(c, workspaceId, connectionId))) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.json(await oauth2ConnectionStatus(connectionId));
});
