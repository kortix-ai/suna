/** Who is calling: resolve the connector principal from a token or a project path, and the admin/reader/manager authorization checks. */
import { connectors, projectSessions, projects } from '@kortix/db';
import { CHANNEL_PLATFORM_IDS } from '@kortix/shared/channel-descriptors';
import { and, eq } from 'drizzle-orm';
import { reconcileStoredSessionAgentGrant } from '../projects/lib/session-token-grant';
import { canonicalConnectorAlias } from '../projects/lib/session-connector-bindings';
import {
  type AccountTokenValidationResult,
  findRemintedSessionTokenId,
  validateAccountToken,
  validateAccountTokenByIdForHeldRun,
} from '../repositories/account-tokens';
import { accountMemberRow } from '../iam/membership-read';
import { db } from '../shared/db';
import { tokenAgentPrincipalScope } from '../projects/lib/personal-resources';
import type { CallPolicySet } from './gateway';
import type { HeldCallInput } from './held-call-store';
import { callPolicySetOf, principalMayUseConnector } from './principal-access';
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
const CHANNEL_SOURCES: ReadonlySet<string> = new Set(CHANNEL_PLATFORM_IDS);

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

/** Why an approved held call does not run as its caller. Expected outcomes, never thrown. */
export type HeldPrincipalRefusal =
  /** No live token for the caller (revoked, expired, deleted session, offboarded member), or the call had none. */
  | 'caller_revoked'
  /** The token row no longer names the caller, project or session the call was held for. */
  | 'caller_mismatch'
  /** The agent grant no longer allows the connector, or never did at gate time. */
  | 'grant_narrowed'
  /** The agent-principal mode, agent or on-behalf-of user changed since the gate. */
  | 'principal_mode_changed';

export type HeldPrincipalResult =
  | { ok: true; principal: ConnectorPrincipal; policySet: CallPolicySet | null }
  | { ok: false; reason: HeldPrincipalRefusal };

/**
 * The caller of a held call, rebuilt at run time from the decrypted held input
 * without the raw token. The authority is the smaller of the gate-time snapshot
 * and the current state: a shrunk grant refuses, a grown grant does not widen.
 * The sandbox-lease check is the only token check it skips. A stopped box is
 * the normal state hours after a hold.
 *
 * The account comes from the token row, never from the snapshot: a project
 * transfer rewrites it. Only a project-scoped token is supported. A call held
 * from a JWT or an unscoped PAT has no server-side credential to re-check and
 * refuses `caller_revoked`.
 *
 * Throws only for a transient error (DB, manifest read without a stored grant).
 */
export async function rebuildHeldCallPrincipal(held: HeldCallInput): Promise<HeldPrincipalResult> {
  if (!held.acting_token_id) return { ok: false, reason: 'caller_revoked' };
  const token = await liveHeldRunToken(held);
  if (!token) return { ok: false, reason: 'caller_revoked' };
  if (
    token.userId !== held.user_id ||
    token.projectId !== held.project_id ||
    (token.sessionId ?? null) !== held.session_id
  ) {
    return { ok: false, reason: 'caller_mismatch' };
  }
  const accountId = token.accountId!;
  const projectId = held.project_id;
  const userId = held.user_id;
  const sessionId = held.session_id;

  const [[project], [member]] = await Promise.all([
    db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, projectId)).limit(1),
    accountMemberRow(accountId, userId),
  ]);
  if (!project || project.accountId !== accountId) return { ok: false, reason: 'caller_mismatch' };
  // Offboarding revokes the tokens, and logs when that fails. The membership
  // read closes that gap for a held run.
  if (!member) return { ok: false, reason: 'caller_revoked' };

  const [agentGrant, channelConnectorSlugs] = await Promise.all([
    sessionId
      ? reconcileStoredSessionAgentGrant({ projectId, sessionId, storedGrant: token.agentGrant ?? null })
      : Promise.resolve(token.agentGrant ?? null),
    sessionChannelConnectorSlugs(projectId, sessionId),
  ]);
  const slug = canonicalConnectorAlias(held.connector_slug);
  if (
    !principalMayUseConnector({ agentGrant: held.agent_grant, channelConnectorSlugs }, slug) ||
    !principalMayUseConnector({ agentGrant, channelConnectorSlugs }, slug)
  ) {
    return { ok: false, reason: 'grant_narrowed' };
  }

  const agentPrincipal = await tokenAgentPrincipalScope({
    projectId,
    tokenId: token.tokenId,
    agentGrant,
    onBehalfOfUserId: token.onBehalfOfUserId ?? null,
  });
  if (!sameAgentPrincipal(held.agent_principal, agentPrincipal)) {
    return { ok: false, reason: 'principal_mode_changed' };
  }

  const principal: ConnectorPrincipal = {
    userId,
    accountId,
    projectId,
    sessionId,
    tokenId: token.tokenId ?? null,
    subject: await resolveShareSubject(userId),
    agentGrant,
    channelConnectorSlugs,
    agentPrincipal,
    requestedConnectorAccount: held.connection_id,
  };
  return { ok: true, principal, policySet: callPolicySetOf(principal, held.connector_slug) };
}

/**
 * The held token when it is live, else the same-identity token that re-minted
 * it (a removed sandbox revokes the session token; the next start mints a new
 * one). Null when neither is live. Throws on a validation error that is not a
 * dead credential.
 */
async function liveHeldRunToken(held: HeldCallInput): Promise<AccountTokenValidationResult | null> {
  const first = await validHeldRunToken(held.acting_token_id!);
  if (first) return first;
  if (!held.session_id) return null;
  const remintedId = await findRemintedSessionTokenId(held.acting_token_id!);
  return remintedId ? validHeldRunToken(remintedId) : null;
}

async function validHeldRunToken(tokenId: string): Promise<AccountTokenValidationResult | null> {
  const result = await validateAccountTokenByIdForHeldRun(tokenId);
  if (result.isValid && result.userId && result.accountId && result.projectId) return result;
  if (result.isValid || result.credentialDead) return null;
  throw new Error(`held-call token check failed: ${result.error ?? 'unknown'}`);
}

/**
 * The agent-principal scope must be the one the call was held under: the same
 * mode and the same agent. The on-behalf-of user may only stay or clear, never
 * become another person.
 */
function sameAgentPrincipal(
  snapshot: HeldCallInput['agent_principal'],
  current: { onBehalfOfUserId: string | null; agentId: string | null } | null,
): boolean {
  if (!snapshot || !current) return !snapshot && !current;
  if ((snapshot.agentId ?? null) !== current.agentId) return false;
  return current.onBehalfOfUserId === null || current.onBehalfOfUserId === snapshot.onBehalfOfUserId;
}
