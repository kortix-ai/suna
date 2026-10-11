/** Who is calling: resolve the connector principal from a token or a project path, and the admin/reader/manager authorization checks. */
import { connectors, projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { reconcileStoredSessionAgentGrant } from '../projects/lib/session-token-grant';
import { canonicalConnectorAlias } from '../projects/lib/session-connector-bindings';
import { validateAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { tokenAgentPrincipalScope } from '../projects/lib/personal-resources';
import type { ConnectorPrincipal } from './router-contract';
import { resolveShareSubject } from './share';
import { channelPlatform } from './db-deps-rows';

// The request authorizers (`resolvePrincipal`, `resolveProjectPrincipal`,
// `resolveAdmin`, `resolveConnectionsManager`, `resolveSecretBindingAdmin`,
// `resolveReader`, `resolveSecretReader`) read the Hono request, so they live in
// `http-principal.ts`. Re-exported here so every importer keeps working.
export {
  resolveAdmin,
  resolveConnectionsManager,
  resolvePrincipal,
  resolveProjectPrincipal,
  resolveReader,
  resolveSecretBindingAdmin,
  resolveSecretReader,
} from './http-principal';

export function resolveTokenBoundSessionId(
  authenticatedSessionId: string | null,
  requestedSessionId: string | null,
): { ok: true; sessionId: string | null } | { ok: false } {
  if (requestedSessionId && requestedSessionId !== authenticatedSessionId) {
    return { ok: false };
  }
  return { ok: true, sessionId: authenticatedSessionId };
}

/**
 * Only project-scoped tokens carry a Kortix project session identity.
 * Supabase JWTs also set `sessionId`, but that value identifies the Supabase
 * authentication session. It must not enter connection resolution.
 */
export function projectSessionIdForProjectPrincipal(
  tokenProjectId: string | undefined,
  contextualSessionId: string | undefined,
): string | null {
  return tokenProjectId ? (contextualSessionId ?? null) : null;
}

/**
 * The channel connector(s) that CREATED a session, resolved from the session's
 * own `metadata.source` and the project's channel connector rows — never from
 * the request. See `principalMayUseConnector` for why they stay reachable
 * under any grant.
 */
export async function sessionChannelConnectorSlugs(
  projectId: string,
  sessionId: string | null,
): Promise<string[]> {
  if (!sessionId) return [];
  try {
    const [session] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
      .limit(1);
    const source = (session?.metadata as { source?: unknown } | null)?.source;
    if (typeof source !== 'string' || !CHANNEL_SOURCES.has(source)) return [];
    const rows = await db
      .select({ slug: connectors.slug, config: connectors.config, providerType: connectors.providerType })
      .from(connectors)
      .where(
        and(
          eq(connectors.projectId, projectId),
          eq(connectors.providerType, 'channel'),
          eq(connectors.enabled, true),
        ),
      );
    return rows
      .filter((row) => channelPlatform(row.config) === source)
      .map((row) => canonicalConnectorAlias(row.slug));
  } catch (err) {
    console.warn('[connectors] could not resolve the session channel connector', {
      projectId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** `project_sessions.metadata.source` values that name a channel platform. */
const CHANNEL_SOURCES: ReadonlySet<string> = new Set(['slack', 'teams', 'email', 'telegram']);

/**
 * The connector principal a bearer token names, or null when there is no
 * token, it is not a valid project-scoped token, or `requestedSessionId` names
 * a session the token is not bound to. The HTTP reader is `resolvePrincipal`
 * (`http-principal.ts`).
 */
export async function resolveTokenPrincipal(
  token: string | null,
  requestedSessionId: string | null,
): Promise<ConnectorPrincipal | null> {
  if (!token) return null;
  const result = await validateAccountToken(token);
  if (!result.isValid || !result.userId || !result.accountId || !result.projectId) return null;
  const sessionIdentity = resolveTokenBoundSessionId(
    result.sessionId ?? null,
    requestedSessionId,
  );
  if (!sessionIdentity.ok) return null;
  const [agentGrant, channelConnectorSlugs] = await Promise.all([
    sessionIdentity.sessionId
      ? reconcileStoredSessionAgentGrant({
          projectId: result.projectId,
          sessionId: sessionIdentity.sessionId,
          // The row `validateAccountToken` just read carries the session's
          // stored grant (already normalized) — a re-mint rewrites every
          // ACTIVE token of the session, so there is no second read to do.
          storedGrant: result.agentGrant ?? null,
        })
      : Promise.resolve(result.agentGrant ?? null),
    sessionChannelConnectorSlugs(result.projectId, sessionIdentity.sessionId),
  ]);
  return {
    userId: result.userId,
    accountId: result.accountId,
    projectId: result.projectId,
    sessionId: sessionIdentity.sessionId,
    tokenId: result.tokenId ?? null,
    subject: await resolveShareSubject(result.userId),
    agentGrant,
    channelConnectorSlugs,
    agentPrincipal: await tokenAgentPrincipalScope({
      projectId: result.projectId,
      tokenId: result.tokenId ?? null,
      agentGrant,
      onBehalfOfUserId: result.onBehalfOfUserId ?? null,
    }),
  };
}
