/**
 * Personal resources of an agent session — spec
 * docs/specs/2026-09-22-agents-as-principals.md §2.3.
 *
 * A resource owned by one human (a member-owned connector connection, a
 * personal project-secret override, a personal provider key, that human's own
 * Agent Computer Tunnel machine) is reachable by an agent session only when:
 *
 *     owner == on_behalf_of  AND  the session is `private`
 *
 * `on_behalf_of` lives on the session token (`account_tokens.on_behalf_of_user_id`,
 * projects/lib/on-behalf-of.ts). It is NULL for every unattended run (trigger,
 * cron, webhook, channel without a linked user) and after another human
 * prompted the session. NULL = no personal resource at all.
 *
 * Flag OFF, or an ungoverned (null-grant) token: the legacy rule applies byte
 * for byte — each caller keeps the user id it used before (`legacyUserId`).
 *
 * ONE rule, three readers:
 *   - `personalResourceOwner`       pure decision (unit-tested)
 *   - `actorPersonalScope`          request time, from the canonical Actor
 *   - `resolveSessionPersonalOwner` server side, from the session id alone
 *                                   (sandbox env build, env hot-push, secret
 *                                   relay, LLM gateway principal)
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { accountTokens, projectSessions, readStoredAgentGrant } from '@kortix/db';
import type { AgentGrant } from '@kortix/db';
import { loadTokenBinding, type Actor } from '../../iam/actor';
import { agentPrincipalModeFor, isGovernedAgentGrant, loadAgentPrincipalFlag } from '../../iam/agent-principal';
import { db } from '../../shared/db';
import type { Context } from 'hono';
import { getRequestOnBehalfOf, resolveSessionOnBehalfOf } from './on-behalf-of';

export type PersonalSessionVisibility = 'private' | 'project' | 'restricted';

/**
 * The user whose personal resources this caller may reach, or null for none.
 *
 * - `agentPrincipal` false: the legacy answer, unchanged.
 * - `agentPrincipal` true: `onBehalfOfUserId` when the session is private,
 *   otherwise null. A missing visibility (no session in scope) is not
 *   `private`: an agent credential without a session never reaches a person.
 */
export function personalResourceOwner(input: {
  agentPrincipal: boolean;
  legacyUserId: string | null;
  onBehalfOfUserId: string | null;
  visibility: PersonalSessionVisibility | null;
}): string | null {
  if (!input.agentPrincipal) return input.legacyUserId;
  if (!input.onBehalfOfUserId) return null;
  return input.visibility === 'private' ? input.onBehalfOfUserId : null;
}

/**
 * The personal-resource inputs a request's credential carries.
 *
 * `agentPrincipal` = the credential is an agent session under the
 * agent-principal model (flag ON, governed grant). `onBehalfOfUserId` prefers
 * the fresh per-request value from the auth middleware (`fresh`), because the
 * actor's copy rides a 15 s token-binding memo and a clear must take effect on
 * the next request.
 */
export function actorPersonalScope(
  actor: Actor | null | undefined,
  fresh?: string | null,
): { agentPrincipal: boolean; onBehalfOfUserId: string | null } {
  const credential = actor?.credential;
  if (!credential || credential.kind !== 'agent_session' || credential.agentPrincipal !== true) {
    return { agentPrincipal: false, onBehalfOfUserId: null };
  }
  const onBehalfOfUserId = fresh !== undefined ? fresh : (credential.onBehalfOfUserId ?? null);
  return { agentPrincipal: true, onBehalfOfUserId: onBehalfOfUserId ?? null };
}

/**
 * The machine owners an Agent Computer Tunnel call may reach ("own
 * computer"). A connector profile stores the owner of every machine it lists:
 * the team account (shared) or one member's user id (that member's own
 * computer). Only an agent-principal caller is filtered: it keeps the team
 * account plus `personalOwner` (from `personalResourceOwner`). `null` owners
 * (a legacy aggregate row = every team machine) pass through.
 */
export function filterPersonalTunnelOwners(input: {
  accountId: string;
  owners: string[] | null;
  personalOwner: string | null;
}): string[] | null {
  if (input.owners === null) return null;
  return input.owners.filter((owner) => owner === input.accountId || owner === input.personalOwner);
}

/**
 * Server-side resolution for one session: the user whose personal resources
 * the session may reach, or null.
 *
 * Reads the project flag (15 s memo), the session row, and the session's live
 * agent token. When no token exists yet (the sandbox env is built in parallel
 * with the token mint) the mint rule itself decides `on_behalf_of`, and the
 * agent counts as governed: under the flag the strict rule is the fail-closed
 * default, and for a human's private session it gives the same answer.
 *
 * Any read failure resolves to null under the flag: a missing value costs
 * personal resources only, never shared ones.
 *
 * `visibility` answers for a sharing change before it is stored: the same
 * rule, with that visibility in place of the session's current one.
 */
export async function resolveSessionPersonalOwner(input: {
  projectId: string;
  sessionId: string | null | undefined;
  /** What the pre-flag code used (the session creator, or the token user). */
  legacyUserId: string | null;
  accountId?: string | null;
  /** A pending visibility to resolve against instead of the stored one. */
  visibility?: PersonalSessionVisibility;
}): Promise<string | null> {
  if (!input.sessionId) return input.legacyUserId;
  let flag = false;
  try {
    flag = await loadAgentPrincipalFlag(input.projectId);
  } catch {
    return input.legacyUserId;
  }
  if (!flag) return input.legacyUserId;
  try {
    const [session] = await db
      .select({
        accountId: projectSessions.accountId,
        visibility: projectSessions.visibility,
        createdBy: projectSessions.createdBy,
      })
      .from(projectSessions)
      .where(and(eq(projectSessions.sessionId, input.sessionId), eq(projectSessions.projectId, input.projectId)))
      .limit(1);
    if (!session) return null;
    const visibility = input.visibility ?? session.visibility;
    const [token] = await db
      .select({
        agentGrant: accountTokens.agentGrant,
        onBehalfOfUserId: accountTokens.onBehalfOfUserId,
      })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.sessionId, input.sessionId),
          eq(accountTokens.status, 'active'),
          isNull(accountTokens.revokedAt),
          isNotNull(accountTokens.serviceAccountId),
        ),
      )
      .limit(1);
    if (token) {
      const grant = readStoredAgentGrant(token.agentGrant);
      if (!isGovernedAgentGrant(grant)) return input.legacyUserId;
      return personalResourceOwner({
        agentPrincipal: true,
        legacyUserId: input.legacyUserId,
        onBehalfOfUserId: token.onBehalfOfUserId ?? null,
        visibility,
      });
    }
    const minted = await resolveSessionOnBehalfOf({
      accountId: input.accountId ?? session.accountId,
      sessionId: input.sessionId,
      userId: session.createdBy ?? input.legacyUserId ?? '',
    });
    return personalResourceOwner({
      agentPrincipal: true,
      legacyUserId: input.legacyUserId,
      onBehalfOfUserId: minted,
      visibility,
    });
  } catch (err) {
    console.warn('[personal-resources] session resolution failed; no personal resources', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The agent-principal scope of a token presented to an out-of-band surface
 * (the connector gateway, the LLM gateway), which authenticates the token
 * itself instead of through the canonical Actor.
 *
 * Returns null (legacy rule) unless the token names an agent service account,
 * its grant is governed, and the project's flag is ON. `onBehalfOfUserId` is
 * the value the caller read fresh from the token row.
 */
export async function tokenAgentPrincipalScope(input: {
  projectId: string | null | undefined;
  tokenId: string | null | undefined;
  agentGrant: AgentGrant | null | undefined;
  onBehalfOfUserId: string | null | undefined;
}): Promise<{ onBehalfOfUserId: string | null } | null> {
  if (!input.tokenId || !input.projectId) return null;
  try {
    const binding = await loadTokenBinding(input.tokenId);
    if (!binding?.serviceAccountId) return null;
    if (!(await agentPrincipalModeFor(input.projectId, input.agentGrant ?? binding.agentGrant))) return null;
  } catch {
    return null;
  }
  return { onBehalfOfUserId: input.onBehalfOfUserId ?? null };
}

/**
 * Request-time reach of an agent-principal credential, in the shape
 * `connectionIsReachable({ agentPrincipal })` takes: the fresh on_behalf_of
 * and the visibility of the credential's own session. Null for every legacy
 * or human caller, which keeps their rule unchanged.
 */
export async function requestAgentPrincipalReach(
  c: Context,
  actor?: Actor | null,
): Promise<{ onBehalfOfUserId: string | null; visibility: PersonalSessionVisibility | null } | null> {
  const resolvedActor = actor ?? ((c.get('actor') as Actor | undefined) ?? null);
  const scope = actorPersonalScope(resolvedActor, getRequestOnBehalfOf(c));
  if (!scope.agentPrincipal) return null;
  const credential = resolvedActor?.credential;
  const sessionId =
    (credential?.kind === 'agent_session' ? credential.sessionId : null) ??
    ((c.get('sessionId') as string | undefined) ?? null);
  if (!scope.onBehalfOfUserId || !sessionId) return { onBehalfOfUserId: null, visibility: null };
  const [session] = await db
    .select({ visibility: projectSessions.visibility })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return { onBehalfOfUserId: scope.onBehalfOfUserId, visibility: session?.visibility ?? null };
}

/**
 * Request-time owner of personal resources for a project route: the caller
 * (`loaded.userId`) for a human or legacy credential; under the
 * agent-principal model the on-behalf-of human of a private session, else
 * null (shared resources only).
 */
export async function requestPersonalOwner(
  c: Context,
  loaded: { userId: string; actor?: Actor | null },
): Promise<string | null> {
  const reach = await requestAgentPrincipalReach(c, loaded.actor ?? null);
  if (!reach) return loaded.userId;
  return personalResourceOwner({
    agentPrincipal: true,
    legacyUserId: loaded.userId,
    onBehalfOfUserId: reach.onBehalfOfUserId,
    visibility: reach.visibility,
  });
}
