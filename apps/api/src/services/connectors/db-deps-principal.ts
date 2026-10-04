/** Who is calling: resolve the connector principal from a token or a project path, and the admin/reader/manager authorization checks. */
import { connectors, projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { reconcileStoredSessionAgentGrant } from '../sessions/session-token-grant';
import { canonicalConnectorAlias } from '../sessions/session-connector-bindings';
import { validateAccountToken } from '../repositories/account-tokens';
import { db } from '../../lib/db';
import { tokenAgentPrincipalScope } from '../projects/lib/personal-resources';
import type { ConnectorPrincipal } from './router-contract';
import { resolveShareSubject } from './share';
import { channelPlatform } from './db-deps-rows';

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
 * The gateway principal for a connector token, or null for 401.
 * `requestedSessionId` is the `X-Kortix-Session-Id` header.
 */
export async function resolveTokenPrincipal(
  token: string,
  requestedSessionId: string | null,
): Promise<ConnectorPrincipal | null> {
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

/** The account that owns `projectId`, or null when there is no such project. */
export async function connectorProjectAccountId(projectId: string): Promise<string | null> {
  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return project?.accountId ?? null;
}

/** What the request carried for a project-explicit principal, once the
 *  caller's access to the project and its account are settled. */
export interface ProjectPrincipalRequest {
  userId: string;
  accountId: string;
  projectId: string;
  /** The project a project-scoped (session) token is pinned to. */
  tokenProjectId: string | undefined;
  /** The auth middleware's `sessionId`: a Kortix session for a project-scoped
   *  token, the Supabase login session for a JWT. */
  contextualSessionId: string | undefined;
  /** The `X-Kortix-Session-Id` header. */
  requestedSessionId: string | null;
  /** The agent grant the auth middleware read with the token. */
  storedAgentGrant: ConnectorPrincipal['agentGrant'];
  tokenId: string | null;
  /** The fresh on_behalf_of the auth middleware read. */
  onBehalfOfUserId: string | null;
}

/** The principal for the project-EXPLICIT gateway routes. Null → 403. */
export async function projectPrincipalFor(input: ProjectPrincipalRequest): Promise<ConnectorPrincipal | null> {
  const { userId, accountId, projectId, tokenProjectId, tokenId } = input;
  const sessionIdentity = resolveTokenBoundSessionId(
    projectSessionIdForProjectPrincipal(tokenProjectId, input.contextualSessionId),
    input.requestedSessionId,
  );
  if (!sessionIdentity.ok) return null;

  const [agentGrant, channelConnectorSlugs] = await Promise.all([
    sessionIdentity.sessionId
      ? reconcileStoredSessionAgentGrant({
          projectId,
          sessionId: sessionIdentity.sessionId,
        })
      : Promise.resolve(input.storedAgentGrant),
    sessionChannelConnectorSlugs(projectId, sessionIdentity.sessionId),
  ]);

  return {
    userId,
    accountId,
    projectId,
    sessionId: sessionIdentity.sessionId,
    tokenId,
    subject: await resolveShareSubject(userId),
    agentGrant,
    channelConnectorSlugs,
    // Only a project-scoped (session) token can be an agent principal; a
    // human JWT/PAT keeps the legacy rule. The fresh on_behalf_of comes from
    // the auth middleware, so a clear by a foreign prompt applies at once.
    agentPrincipal: tokenProjectId
      ? await tokenAgentPrincipalScope({
          projectId,
          tokenId,
          agentGrant,
          onBehalfOfUserId: input.onBehalfOfUserId,
        })
      : null,
  };
}
