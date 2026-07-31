import { createHash } from 'node:crypto';
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import {
  executorConnectionProfiles,
  executorConnectors,
  executorCredentials,
  executorOAuthApplications,
  executorOAuthSessions,
} from '@kortix/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  connectorAuthorizationMatchesStrategy,
  isTrustedManagedChannelAuthorization,
} from '../projects/lib/connector-authorization-strategy';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';
import { upsertProfileCredential } from './credentials';
import {
  createStoredDelegatedCredential,
  parseDelegatedCredential,
} from './oauth2-delegated';
import {
  buildOAuth2AuthorizationRequest,
  discoverOAuth2Metadata,
  exchangeOAuth2AuthorizationCode,
  pollOAuth2DeviceAuthorization,
  revokeOAuth2Token,
  startOAuth2DeviceAuthorization,
} from './oauth2-lifecycle';

interface ProfileIdentity {
  accountId: string;
  projectId: string;
  connectorId: string;
  profileId: string;
}

async function authorizationCanCompleteOAuth(
  profileId: string,
  initiatedBy: string,
): Promise<boolean> {
  const [authorization] = await db
    .select({
      ownerType: executorConnectionProfiles.ownerType,
      ownerId: executorConnectionProfiles.ownerId,
      metadata: executorConnectionProfiles.metadata,
      authorizationStrategy: executorConnectors.authorizationStrategy,
      providerType: executorConnectors.providerType,
      connectorConfig: executorConnectors.config,
    })
    .from(executorConnectionProfiles)
    .innerJoin(
      executorConnectors,
      and(
        eq(executorConnectors.connectorId, executorConnectionProfiles.connectorId),
        eq(executorConnectors.accountId, executorConnectionProfiles.accountId),
        eq(executorConnectors.projectId, executorConnectionProfiles.projectId),
      ),
    )
    .where(eq(executorConnectionProfiles.profileId, profileId))
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

export async function saveOAuth2Application(
  identity: ProfileIdentity,
  application: OAuth2ApplicationInput,
  createdBy: string,
): Promise<void> {
  const configEnc = encryptProjectSecret(identity.projectId, JSON.stringify(application));
  await db
    .insert(executorOAuthApplications)
    .values({ ...identity, configEnc, createdBy })
    .onConflictDoUpdate({
      target: executorOAuthApplications.profileId,
      set: { configEnc, updatedAt: new Date() },
    });
}

export async function loadOAuth2Application(profileId: string): Promise<{
  applicationId: string;
  accountId: string;
  projectId: string;
  connectorId: string;
  profileId: string;
  application: OAuth2ApplicationInput;
} | null> {
  const [row] = await db
    .select()
    .from(executorOAuthApplications)
    .where(eq(executorOAuthApplications.profileId, profileId))
    .limit(1);
  if (!row) return null;
  return {
    applicationId: row.applicationId,
    accountId: row.accountId,
    projectId: row.projectId,
    connectorId: row.connectorId,
    profileId: row.profileId,
    application: JSON.parse(
      decryptProjectSecret(row.projectId, row.configEnc),
    ) as OAuth2ApplicationInput,
  };
}

export function redactOAuth2Application(application: OAuth2ApplicationInput) {
  const { client_secret, private_key, ...view } = application;
  return {
    ...view,
    has_client_secret: !!client_secret,
    has_private_key: !!private_key,
  };
}

export async function discoverConfiguredOAuth2Application(
  discoveryUrl: string,
): Promise<Partial<OAuth2ApplicationInput>> {
  return discoverOAuth2Metadata(discoveryUrl);
}

export async function createAuthorizationCodeSession(input: {
  profileId: string;
  initiatedBy: string;
  callbackUrl: string;
  scopes?: string[];
  successRedirectUri?: string;
  errorRedirectUri?: string;
}) {
  const loaded = await loadOAuth2Application(input.profileId);
  if (!loaded) throw new Error('OAuth2 application is not configured');
  const request = buildOAuth2AuthorizationRequest(loaded.application, {
    callbackUrl: input.callbackUrl,
    scopes: input.scopes,
  });
  await db.insert(executorOAuthSessions).values({
    applicationId: loaded.applicationId,
    accountId: loaded.accountId,
    projectId: loaded.projectId,
    profileId: loaded.profileId,
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
      .from(executorOAuthSessions)
      .where(
        and(
          eq(executorOAuthSessions.stateHash, input.stateHash),
          eq(executorOAuthSessions.flow, 'authorization_code'),
          eq(executorOAuthSessions.status, 'pending'),
          isNull(executorOAuthSessions.consumedAt),
          gt(executorOAuthSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) return null;
    await tx
      .update(executorOAuthSessions)
      .set({ status: 'consumed', consumedAt: new Date(), updatedAt: new Date() })
      .where(eq(executorOAuthSessions.sessionId, row.sessionId));
    return row;
  });
  if (!claimed) return { redirectUri: null, ok: false, errorCode: 'invalid_state' };
  if (!(await authorizationCanCompleteOAuth(claimed.profileId, claimed.initiatedBy))) {
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
      .update(executorConnectionProfiles)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(executorConnectionProfiles.profileId, claimed.profileId));
    return { redirectUri: claimed.errorRedirectUri, ok: false, errorCode };
  }
  try {
    const loaded = await loadOAuth2Application(claimed.profileId);
    if (!loaded || !claimed.pkceVerifierEnc) throw new Error('OAuth2 session is incomplete');
    const token = await exchangeOAuth2AuthorizationCode(
      loaded.application,
      {
        code: input.code,
        callbackUrl: input.callbackUrl,
        pkceVerifier: decryptProjectSecret(claimed.projectId, claimed.pkceVerifierEnc),
      },
    );
    await upsertProfileCredential({
      projectId: loaded.projectId,
      connectorId: loaded.connectorId,
      profileId: loaded.profileId,
      value: createStoredDelegatedCredential(loaded.application, token),
      kind: 'oauth2_delegated',
      createdBy: claimed.initiatedBy,
    });
    return { redirectUri: claimed.successRedirectUri, ok: true };
  } catch (error) {
    await db
      .update(executorConnectionProfiles)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(executorConnectionProfiles.profileId, claimed.profileId));
    return {
      redirectUri: claimed.errorRedirectUri,
      ok: false,
      errorCode: 'token_exchange_failed',
    };
  }
}

export async function createDeviceAuthorizationSession(input: {
  profileId: string;
  initiatedBy: string;
  scopes?: string[];
}) {
  const loaded = await loadOAuth2Application(input.profileId);
  if (!loaded) throw new Error('OAuth2 application is not configured');
  const application = {
    ...loaded.application,
    scopes: input.scopes ?? loaded.application.scopes,
  };
  const started = await startOAuth2DeviceAuthorization(application);
  const [session] = await db
    .insert(executorOAuthSessions)
    .values({
      applicationId: loaded.applicationId,
      accountId: loaded.accountId,
      projectId: loaded.projectId,
      profileId: loaded.profileId,
      initiatedBy: input.initiatedBy,
      flow: 'device_authorization',
      deviceCodeEnc: encryptProjectSecret(loaded.projectId, started.deviceCode),
      scopes: application.scopes,
      intervalSeconds: started.intervalSeconds,
      nextPollAt: new Date(Date.now() + started.intervalSeconds * 1000),
      expiresAt: new Date(started.expiresAt),
    })
    .returning({ sessionId: executorOAuthSessions.sessionId });
  return { ...started, sessionId: session!.sessionId };
}

export async function pollDeviceAuthorizationSession(input: {
  profileId: string;
  sessionId: string;
  initiatedBy: string;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.sessionId}::text, 0))`,
    );
    const [session] = await tx
      .select()
      .from(executorOAuthSessions)
      .where(
        and(
          eq(executorOAuthSessions.sessionId, input.sessionId),
          eq(executorOAuthSessions.profileId, input.profileId),
          eq(executorOAuthSessions.initiatedBy, input.initiatedBy),
          eq(executorOAuthSessions.flow, 'device_authorization'),
        ),
      )
      .limit(1);
    if (!session) throw new Error('OAuth2 device session not found');
    if (session.status === 'active') return { status: 'active' as const };
    if (session.expiresAt <= new Date()) {
      await tx
        .update(executorOAuthSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(executorOAuthSessions.sessionId, session.sessionId));
      return { status: 'expired' as const };
    }
    if (session.nextPollAt && session.nextPollAt > new Date()) {
      return { status: 'pending' as const };
    }
    const loaded = await loadOAuth2Application(session.profileId);
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
        .update(executorOAuthSessions)
        .set({
          intervalSeconds: interval,
          nextPollAt: new Date(Date.now() + interval * 1000),
          updatedAt: new Date(),
        })
        .where(eq(executorOAuthSessions.sessionId, session.sessionId));
      return { status: 'pending' as const };
    }
    if (result.status === 'expired' || result.status === 'denied') {
      await tx
        .update(executorOAuthSessions)
        .set({
          status: 'error',
          errorCode: result.status === 'denied' ? 'access_denied' : 'expired_token',
          consumedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(executorOAuthSessions.sessionId, session.sessionId));
      return { status: 'error' as const, error_code: result.status };
    }
    await upsertProfileCredential({
      projectId: loaded.projectId,
      connectorId: loaded.connectorId,
      profileId: loaded.profileId,
      value: createStoredDelegatedCredential(loaded.application, result.token),
      kind: 'oauth2_delegated',
      createdBy: session.initiatedBy,
    });
    await tx
      .update(executorOAuthSessions)
      .set({ status: 'active', consumedAt: new Date(), updatedAt: new Date() })
      .where(eq(executorOAuthSessions.sessionId, session.sessionId));
    return {
      status: 'active' as const,
      expires_at: new Date(result.token.expires_at).toISOString(),
      scopes: result.token.scopes,
    };
  });
}

export async function oauth2ProfileStatus(profileId: string) {
  const [credential] = await db
    .select({
      valueEnc: executorCredentials.valueEnc,
      kind: executorCredentials.kind,
      projectId: executorOAuthApplications.projectId,
      profileStatus: executorConnectionProfiles.status,
    })
    .from(executorOAuthApplications)
    .innerJoin(
      executorConnectionProfiles,
      eq(executorConnectionProfiles.profileId, executorOAuthApplications.profileId),
    )
    .leftJoin(executorCredentials, eq(executorCredentials.profileId, profileId))
    .where(eq(executorOAuthApplications.profileId, profileId))
    .limit(1);
  if (!credential) return { status: 'not_configured' as const };
  if (credential.profileStatus === 'revoked') return { status: 'revoked' as const };
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

export async function revokeProfileOAuth2(profileId: string): Promise<void> {
  const loaded = await loadOAuth2Application(profileId);
  if (!loaded) return;
  const [credential] = await db
    .select({ credentialId: executorCredentials.credentialId, valueEnc: executorCredentials.valueEnc })
    .from(executorCredentials)
    .where(eq(executorCredentials.profileId, profileId))
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
      .delete(executorCredentials)
      .where(eq(executorCredentials.credentialId, credential.credentialId));
  }
  await db
    .update(executorConnectionProfiles)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(eq(executorConnectionProfiles.profileId, profileId));
}

export async function handleNativeOAuth2Callback(requestUrl: string) {
  const url = new URL(requestUrl);
  const state = url.searchParams.get('state');
  if (!state || state.length > 1024) {
    return { status: 400 as const, body: 'Invalid OAuth2 state' };
  }
  const callback = new URL('/v1/integrations/oauth2/callback', requestUrl).href;
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
