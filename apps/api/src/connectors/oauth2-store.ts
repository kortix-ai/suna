import { createHash } from 'node:crypto';
import type {
  OAuth2ApplicationInput,
  OAuth2ClientRegistrationInput,
  OAuth2ResourceDiscovery,
} from '@kortix/api-contract';
import {
  connectorConnections,
  connectors,
  connectionCredentials,
  connectionOAuthApplications,
  connectionOAuthSessions,
} from '@kortix/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  connectorAuthorizationMatchesStrategy,
  isTrustedManagedChannelAuthorization,
} from '../projects/lib/connector-authorization-strategy';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';
import { isUniqueViolation } from '../shared/postgres-errors';
import { config } from '../config';
import { upsertConnectionCredential } from './credentials';
import { nativeOAuth2CallbackUrl } from './oauth2-callback-url';
import {
  createStoredDelegatedCredential,
  parseDelegatedCredential,
} from './oauth2-delegated';
import {
  type OAuth2LifecycleRuntime,
  buildOAuth2AuthorizationRequest,
  discoverOAuth2Metadata,
  exchangeOAuth2AuthorizationCode,
  pollOAuth2DeviceAuthorization,
  revokeOAuth2Token,
  startOAuth2DeviceAuthorization,
} from './oauth2-lifecycle';
import { oauthCompletionRematerializeInput } from './oauth2-rematerialize';
import { registerOAuth2Client } from './oauth2-registration';
import {
  type ProtectedResourceProvider,
  discoverProtectedResourceOAuth2,
} from './oauth2-resource-discovery';

interface ConnectionIdentity {
  accountId: string;
  projectId: string;
  connectorId: string;
  connectionId: string;
}

async function authorizationCanCompleteOAuth(
  connectionId: string,
  initiatedBy: string,
): Promise<boolean> {
  const [authorization] = await db
    .select({
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
        eq(connectors.projectId, connectorConnections.projectId),
      ),
    )
    .where(eq(connectorConnections.connectionId, connectionId))
    .limit(1);
  if (!authorization) return false;
  return connectorAuthorizationMatchesStrategy({
    strategy: authorization.authorizationStrategy,
    ownerType: authorization.ownerType,
    ownerId: authorization.ownerId,
    actingUserId: initiatedBy,
    actingPrincipalIsServiceAccount: false,
    trustedManagedSystem: isTrustedManagedChannelAuthorization({
      providerType: authorization.providerType,
      platform:
        typeof authorization.connectorConfig.platform === 'string'
          ? authorization.connectorConfig.platform
          : null,
      ownerType: authorization.ownerType,
      ownerId: authorization.ownerId,
      metadata: authorization.metadata,
    }),
  });
}

/**
 * Re-fetch the connector catalog now that this connection HAS a credential.
 * Fire-and-forget: the OAuth flow has already succeeded, and a catalog refetch
 * that fails must not turn a completed authorization into an error. The row's
 * own `status` still records whatever the refetch found.
 */
async function rematerializeAfterOAuthCompletion(connectionId: string): Promise<void> {
  try {
    const [row] = await db
      .select({
        accountId: connectorConnections.accountId,
        projectId: connectorConnections.projectId,
        connectorId: connectorConnections.connectorId,
        ownerType: connectorConnections.ownerType,
        isDefault: connectorConnections.isDefault,
        providerType: connectors.providerType,
      })
      .from(connectorConnections)
      .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
      .where(eq(connectorConnections.connectionId, connectionId))
      .limit(1);
    if (!row) return;
    const input = oauthCompletionRematerializeInput(row);
    if (!input) return;
    // Imported lazily: sync.ts pulls in the whole materialization graph, and
    // this module is on the OAuth request path.
    const { rematerializeCatalogAfterCredentialUpdate } = await import('./sync');
    await rematerializeCatalogAfterCredentialUpdate(input);
  } catch (error) {
    console.warn('[connector] OAuth catalog rematerialize failed', {
      connectionId,
      err: (error as Error).message,
    });
  }
}

export async function saveOAuth2Application(
  identity: ConnectionIdentity,
  application: OAuth2ApplicationInput,
  createdBy: string,
): Promise<void> {
  const configEnc = encryptProjectSecret(identity.projectId, JSON.stringify(application));
  const updateExisting = () =>
    db
      .update(connectionOAuthApplications)
      .set({ configEnc, updatedAt: new Date() })
      .where(eq(connectionOAuthApplications.connectionId, identity.connectionId))
      .returning({ applicationId: connectionOAuthApplications.applicationId });
  if ((await updateExisting()).length > 0) return;
  try {
    await db
      .insert(connectionOAuthApplications)
      .values({ ...identity, configEnc, createdBy });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    if ((await updateExisting()).length === 0) throw error;
  }
}

export async function loadOAuth2Application(connectionId: string): Promise<{
  applicationId: string;
  accountId: string;
  projectId: string;
  connectorId: string;
  connectionId: string;
  application: OAuth2ApplicationInput;
} | null> {
  const [row] = await db
    .select()
    .from(connectionOAuthApplications)
    .where(eq(connectionOAuthApplications.connectionId, connectionId))
    .limit(1);
  if (!row) return null;
  return {
    applicationId: row.applicationId,
    accountId: row.accountId,
    projectId: row.projectId,
    connectorId: row.connectorId,
    connectionId: row.connectionId,
    application: JSON.parse(
      decryptProjectSecret(row.projectId, row.configEnc),
    ) as OAuth2ApplicationInput,
  };
}

export function redactOAuth2Application(application: OAuth2ApplicationInput) {
  const { client_secret, private_key, registration_access_token, ...view } = application;
  return {
    ...view,
    has_client_secret: !!client_secret,
    has_private_key: !!private_key,
  };
}

/**
 * The URL a connector exposes as its protected resource: the MCP server URL,
 * an HTTP connector's base URL, a GraphQL endpoint. Null for providers with no
 * single URL (pipedream, channel, computer, openapi without a server).
 */
export function connectorProtectedResource(
  providerType: string,
  config: Record<string, unknown>,
): { url: string; provider: ProtectedResourceProvider } | null {
  const pick = (key: string) =>
    typeof config[key] === 'string' && (config[key] as string).trim()
      ? (config[key] as string).trim()
      : null;
  switch (providerType) {
    case 'mcp': {
      const url = pick('url');
      return url ? { url, provider: 'mcp' } : null;
    }
    case 'http': {
      const url = pick('baseUrl') ?? pick('base_url');
      return url ? { url, provider: 'http' } : null;
    }
    case 'graphql': {
      const url = pick('endpoint');
      return url ? { url, provider: 'graphql' } : null;
    }
    case 'openapi': {
      const url = pick('server');
      return url ? { url, provider: 'http' } : null;
    }
    default:
      return null;
  }
}

/** Run the MCP authorization discovery chain for one connection's connector. */
export async function discoverConnectionOAuth2Resource(
  input: { connectionId: string; resourceUrl?: string },
  runtime: OAuth2LifecycleRuntime = {},
): Promise<OAuth2ResourceDiscovery> {
  const [row] = await db
    .select({ providerType: connectors.providerType, config: connectors.config })
    .from(connectorConnections)
    .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
    .where(eq(connectorConnections.connectionId, input.connectionId))
    .limit(1);
  if (!row) throw new Error('Connection not found');
  const own = connectorProtectedResource(
    row.providerType,
    (row.config ?? {}) as Record<string, unknown>,
  );
  const target = input.resourceUrl
    ? { url: input.resourceUrl, provider: own?.provider ?? ('http' as const) }
    : own;
  if (!target) {
    throw new Error('This connector has no server URL to discover authorization from');
  }
  return discoverProtectedResourceOAuth2(
    { resourceUrl: target.url, provider: target.provider },
    runtime,
  );
}

/**
 * Register Kortix as an OAuth2 client (RFC 7591) at the discovered
 * registration endpoint and save the issued client as the connection's
 * application. The callback URL is the one public redirect URI Kortix owns.
 */
export async function registerConnectionOAuth2Client(
  input: {
    identity: ConnectionIdentity;
    registration: OAuth2ClientRegistrationInput;
    callbackUrl: string;
    createdBy: string;
  },
  runtime: OAuth2LifecycleRuntime = {},
): Promise<OAuth2ApplicationInput> {
  const { registration } = input;
  const issued = await registerOAuth2Client(
    {
      registrationEndpoint: registration.registration_endpoint,
      redirectUri: input.callbackUrl,
      scopes: registration.scopes,
      tokenEndpointAuthMethodsSupported: registration.token_endpoint_auth_methods_supported,
      clientName: registration.client_name,
    },
    runtime,
  );
  const application: OAuth2ApplicationInput = {
    ...(registration.discovery_url ? { discovery_url: registration.discovery_url } : {}),
    ...(registration.authorization_url
      ? { authorization_url: registration.authorization_url }
      : {}),
    ...(registration.token_url ? { token_url: registration.token_url } : {}),
    ...(registration.device_authorization_url
      ? { device_authorization_url: registration.device_authorization_url }
      : {}),
    ...(registration.revocation_url ? { revocation_url: registration.revocation_url } : {}),
    client_id: issued.client_id,
    token_endpoint_auth_method: issued.token_endpoint_auth_method,
    ...(issued.client_secret ? { client_secret: issued.client_secret } : {}),
    ...(registration.scopes?.length ? { scopes: registration.scopes } : {}),
    ...(registration.resource ? { resource: registration.resource } : {}),
    ...(registration.audience ? { audience: registration.audience } : {}),
    ...(issued.registration_client_uri
      ? { registration_client_uri: issued.registration_client_uri }
      : {}),
    ...(issued.registration_access_token
      ? { registration_access_token: issued.registration_access_token }
      : {}),
  };
  await saveOAuth2Application(input.identity, application, input.createdBy);
  return application;
}

export async function discoverConfiguredOAuth2Application(
  discoveryUrl: string,
): Promise<Partial<OAuth2ApplicationInput>> {
  return discoverOAuth2Metadata(discoveryUrl);
}

export async function createAuthorizationCodeSession(input: {
  connectionId: string;
  initiatedBy: string;
  callbackUrl: string;
  scopes?: string[];
  successRedirectUri?: string;
  errorRedirectUri?: string;
}) {
  const loaded = await loadOAuth2Application(input.connectionId);
  if (!loaded) throw new Error('OAuth2 application is not configured');
  const request = buildOAuth2AuthorizationRequest(loaded.application, {
    callbackUrl: input.callbackUrl,
    scopes: input.scopes,
  });
  await db.insert(connectionOAuthSessions).values({
    applicationId: loaded.applicationId,
    accountId: loaded.accountId,
    projectId: loaded.projectId,
    connectionId: loaded.connectionId,
    initiatedBy: input.initiatedBy,
    flow: 'authorization_code',
    stateHash: request.stateHash,
    pkceVerifierEnc: encryptProjectSecret(loaded.projectId, request.pkceVerifier),
    successRedirectUri: input.successRedirectUri,
    errorRedirectUri: input.errorRedirectUri,
    scopes: input.scopes ?? loaded.application.scopes,
    expiresAt: new Date(request.expiresAt),
  });
  return request;
}

export async function completeAuthorizationCodeSession(input: {
  stateHash: string;
  code?: string;
  providerError?: string;
  callbackUrl: string;
}): Promise<{ redirectUri: string | null; ok: boolean; errorCode?: string }> {
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(connectionOAuthSessions)
      .where(
        and(
          eq(connectionOAuthSessions.stateHash, input.stateHash),
          eq(connectionOAuthSessions.flow, 'authorization_code'),
          eq(connectionOAuthSessions.status, 'pending'),
          isNull(connectionOAuthSessions.consumedAt),
          gt(connectionOAuthSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) return null;
    await tx
      .update(connectionOAuthSessions)
      .set({ status: 'consumed', consumedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectionOAuthSessions.sessionId, row.sessionId));
    return row;
  });
  if (!claimed) return { redirectUri: null, ok: false, errorCode: 'invalid_state' };
  if (!(await authorizationCanCompleteOAuth(claimed.connectionId, claimed.initiatedBy))) {
    return {
      redirectUri: claimed.errorRedirectUri,
      ok: false,
      errorCode: 'authorization_strategy_changed',
    };
  }
  if (input.providerError || !input.code) {
    const errorCode =
      input.providerError && /^[A-Za-z0-9_.-]{1,128}$/.test(input.providerError)
        ? input.providerError
        : 'authorization_failed';
    await db
      .update(connectorConnections)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(connectorConnections.connectionId, claimed.connectionId));
    return { redirectUri: claimed.errorRedirectUri, ok: false, errorCode };
  }
  try {
    const loaded = await loadOAuth2Application(claimed.connectionId);
    if (!loaded || !claimed.pkceVerifierEnc) throw new Error('OAuth2 session is incomplete');
    const token = await exchangeOAuth2AuthorizationCode(
      loaded.application,
      {
        code: input.code,
        callbackUrl: input.callbackUrl,
        pkceVerifier: decryptProjectSecret(claimed.projectId, claimed.pkceVerifierEnc),
      },
    );
    await upsertConnectionCredential({
      projectId: loaded.projectId,
      connectorId: loaded.connectorId,
      connectionId: loaded.connectionId,
      value: createStoredDelegatedCredential(loaded.application, token),
      kind: 'oauth2_delegated',
      createdBy: claimed.initiatedBy,
    });
    // The catalog was last fetched WITHOUT this credential, so the connector is
    // very likely sitting on a 401. Refetch before the user sees the result.
    await rematerializeAfterOAuthCompletion(loaded.connectionId);
    return { redirectUri: claimed.successRedirectUri, ok: true };
  } catch (error) {
    await db
      .update(connectorConnections)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(connectorConnections.connectionId, claimed.connectionId));
    return {
      redirectUri: claimed.errorRedirectUri,
      ok: false,
      errorCode: 'token_exchange_failed',
    };
  }
}

export async function createDeviceAuthorizationSession(input: {
  connectionId: string;
  initiatedBy: string;
  scopes?: string[];
}) {
  const loaded = await loadOAuth2Application(input.connectionId);
  if (!loaded) throw new Error('OAuth2 application is not configured');
  const application = {
    ...loaded.application,
    scopes: input.scopes ?? loaded.application.scopes,
  };
  const started = await startOAuth2DeviceAuthorization(application);
  const [session] = await db
    .insert(connectionOAuthSessions)
    .values({
      applicationId: loaded.applicationId,
      accountId: loaded.accountId,
      projectId: loaded.projectId,
      connectionId: loaded.connectionId,
      initiatedBy: input.initiatedBy,
      flow: 'device_authorization',
      deviceCodeEnc: encryptProjectSecret(loaded.projectId, started.deviceCode),
      scopes: application.scopes,
      intervalSeconds: started.intervalSeconds,
      nextPollAt: new Date(Date.now() + started.intervalSeconds * 1000),
      expiresAt: new Date(started.expiresAt),
    })
    .returning({ sessionId: connectionOAuthSessions.sessionId });
  return { ...started, sessionId: session!.sessionId };
}

export async function pollDeviceAuthorizationSession(input: {
  connectionId: string;
  sessionId: string;
  initiatedBy: string;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.sessionId}::text, 0))`,
    );
    const [session] = await tx
      .select()
      .from(connectionOAuthSessions)
      .where(
        and(
          eq(connectionOAuthSessions.sessionId, input.sessionId),
          eq(connectionOAuthSessions.connectionId, input.connectionId),
          eq(connectionOAuthSessions.initiatedBy, input.initiatedBy),
          eq(connectionOAuthSessions.flow, 'device_authorization'),
        ),
      )
      .limit(1);
    if (!session) throw new Error('OAuth2 device session not found');
    if (session.status === 'active') return { status: 'active' as const };
    if (session.expiresAt <= new Date()) {
      await tx
        .update(connectionOAuthSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(connectionOAuthSessions.sessionId, session.sessionId));
      return { status: 'expired' as const };
    }
    if (session.nextPollAt && session.nextPollAt > new Date()) {
      return { status: 'pending' as const };
    }
    const loaded = await loadOAuth2Application(session.connectionId);
    if (!loaded || !session.deviceCodeEnc) throw new Error('OAuth2 device session is incomplete');
    const result = await pollOAuth2DeviceAuthorization(
      { ...loaded.application, scopes: session.scopes ?? loaded.application.scopes },
      decryptProjectSecret(session.projectId, session.deviceCodeEnc),
    );
    const interval = Math.min(
      300,
      (session.intervalSeconds ?? 5) + (result.status === 'slow_down' ? 5 : 0),
    );
    if (result.status === 'pending' || result.status === 'slow_down') {
      await tx
        .update(connectionOAuthSessions)
        .set({
          intervalSeconds: interval,
          nextPollAt: new Date(Date.now() + interval * 1000),
          updatedAt: new Date(),
        })
        .where(eq(connectionOAuthSessions.sessionId, session.sessionId));
      return { status: 'pending' as const };
    }
    if (result.status === 'expired' || result.status === 'denied') {
      await tx
        .update(connectionOAuthSessions)
        .set({
          status: 'error',
          errorCode: result.status === 'denied' ? 'access_denied' : 'expired_token',
          consumedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(connectionOAuthSessions.sessionId, session.sessionId));
      return { status: 'error' as const, error_code: result.status };
    }
    await upsertConnectionCredential({
      projectId: loaded.projectId,
      connectorId: loaded.connectorId,
      connectionId: loaded.connectionId,
      value: createStoredDelegatedCredential(loaded.application, result.token),
      kind: 'oauth2_delegated',
      createdBy: session.initiatedBy,
    });
    await rematerializeAfterOAuthCompletion(loaded.connectionId);
    await tx
      .update(connectionOAuthSessions)
      .set({ status: 'active', consumedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectionOAuthSessions.sessionId, session.sessionId));
    return {
      status: 'active' as const,
      expires_at: new Date(result.token.expires_at).toISOString(),
      scopes: result.token.scopes,
    };
  });
}

export async function oauth2ConnectionStatus(connectionId: string) {
  const [credential] = await db
    .select({
      valueEnc: connectionCredentials.valueEnc,
      kind: connectionCredentials.kind,
      projectId: connectionOAuthApplications.projectId,
      connectionStatus: connectorConnections.status,
    })
    .from(connectionOAuthApplications)
    .innerJoin(
      connectorConnections,
      eq(connectorConnections.connectionId, connectionOAuthApplications.connectionId),
    )
    .leftJoin(connectionCredentials, eq(connectionCredentials.connectionId, connectionId))
    .where(eq(connectionOAuthApplications.connectionId, connectionId))
    .limit(1);
  if (!credential) return { status: 'not_configured' as const };
  if (credential.connectionStatus === 'revoked') return { status: 'revoked' as const };
  if (!credential.valueEnc || credential.kind !== 'oauth2_delegated') {
    return { status: 'ready' as const };
  }
  const stored = parseDelegatedCredential(
    decryptProjectSecret(credential.projectId, credential.valueEnc),
  );
  if (!stored) return { status: 'error' as const, error_code: 'invalid_credential' };
  return {
    status: 'active' as const,
    expires_at: new Date(stored.token.expires_at).toISOString(),
    scopes: stored.token.scopes,
  };
}

export async function revokeConnectionOAuth2(connectionId: string): Promise<void> {
  const loaded = await loadOAuth2Application(connectionId);
  if (!loaded) return;
  const [credential] = await db
    .select({ credentialId: connectionCredentials.credentialId, valueEnc: connectionCredentials.valueEnc })
    .from(connectionCredentials)
    .where(eq(connectionCredentials.connectionId, connectionId))
    .limit(1);
  if (credential) {
    const stored = parseDelegatedCredential(
      decryptProjectSecret(loaded.projectId, credential.valueEnc),
    );
    if (stored && loaded.application.revocation_url) {
      if (stored.token.refresh_token) {
        await revokeOAuth2Token(
          loaded.application,
          stored.token.refresh_token,
          'refresh_token',
        ).catch(() => undefined);
      }
      await revokeOAuth2Token(
        loaded.application,
        stored.token.access_token,
        'access_token',
      ).catch(() => undefined);
    }
    await db
      .delete(connectionCredentials)
      .where(eq(connectionCredentials.credentialId, credential.credentialId));
  }
  await db
    .update(connectorConnections)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(eq(connectorConnections.connectionId, connectionId));
}

export async function handleNativeOAuth2Callback(requestUrl: string) {
  const url = new URL(requestUrl);
  const state = url.searchParams.get('state');
  if (!state || state.length > 1024) {
    return { status: 400 as const, body: 'Invalid OAuth2 state' };
  }
  const callback = nativeOAuth2CallbackUrl(requestUrl, config.KORTIX_URL);
  const result = await completeAuthorizationCodeSession({
    stateHash: createHash('sha256').update(state).digest('hex'),
    code: url.searchParams.get('code') ?? undefined,
    providerError: url.searchParams.get('error') ?? undefined,
    callbackUrl: callback,
  });
  if (!result.redirectUri) {
    return { status: 400 as const, body: 'OAuth2 authorization failed' };
  }
  const redirect = new URL(result.redirectUri);
  redirect.searchParams.set('oauth2', result.ok ? 'connected' : 'error');
  if (result.errorCode) redirect.searchParams.set('oauth2_error', result.errorCode);
  return { status: 302 as const, location: redirect.href };
}
