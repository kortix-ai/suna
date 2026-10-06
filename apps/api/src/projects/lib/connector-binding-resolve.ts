import {
  connectorConnections,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
  serviceAccounts,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { canonicalConnectorAlias } from '../../shared/connector-alias';
import { db } from '../../shared/db';
import { invalidateRequestMemo, requestMemo } from '../../lib/request-context';
import { connectionNeedsPrivateSession } from './connection-access';
import { audiencePersonId, loadConnectionAudience } from './connection-audience';
import {
  type ConnectorConnectionRow,
  type ConnectorRequirementRow,
  type ResolvedSessionConnectorConnection,
  boundConnectionAnswersTo,
  boundConnectionSelect,
  connectorConnectionIsConnected,
  sessionConnectionIsReachable,
} from './connector-binding-shared';
import {
  type ResolvedConnectorConnectionOutcome,
  resolveProjectDefaultConnectorConnectionOutcome,
} from './connector-binding-entitlement';

/** The personal-resource scope of an agent-principal caller (spec §2.3). */
export interface AgentPrincipalPersonalScope {
  /** The human the session acts on behalf of; null = unattended or cleared. */
  onBehalfOfUserId: string | null;
  /** The agent's service account: a shared account whose audience names it is
   *  reachable in every session of that agent. */
  agentId?: string | null;
}

interface SessionConnectorLookup {
  createdBy: string | null;
  visibility: 'private' | 'project' | 'restricted';
  bindingsConfigured: boolean;
  inheritUnbound: boolean;
  createdByServiceAccountId: string | null;
}

function sessionConnectorLookupMemoKey(sessionId: string, accountId: string, projectId: string): string {
  return `session-connector-lookup:${accountId}:${projectId}:${sessionId}`;
}

/**
 * The session/created-by/visibility row `resolveSessionConnectorConnectionOutcome`
 * needs, request-memoized by (session, account, project).
 *
 * A binding read (`resolveEffectiveSessionConnectorBindings`) resolves ONE
 * alias at a time but is called with the SAME sessionId for every alias a
 * grant lists — 'all' resolves against every enabled connector on the project.
 * Before this memo, each alias re-ran this identical join (measured: 49 DB
 * queries / 255ms server time on `GET /sessions/:id/scope` for a session with
 * several granted connectors, 2026-09-27). Request-scoped, not a TTL cache: a
 * write inside the SAME request (`PUT /scope` toggling
 * `connectorBindingsConfigured`) calls `invalidateSessionConnectorLookup` right
 * after its transaction commits, so the post-write re-resolution in that same
 * handler never reads pre-write data back out of this cache.
 */
export async function loadSessionConnectorLookup(
  sessionId: string,
  accountId: string,
  projectId: string,
): Promise<SessionConnectorLookup | null> {
  return requestMemo(sessionConnectorLookupMemoKey(sessionId, accountId, projectId), async () => {
    const [session] = await db
      .select({
        createdBy: projectSessions.createdBy,
        visibility: projectSessions.visibility,
        bindingsConfigured: projectSessions.connectorBindingsConfigured,
        inheritUnbound: projectSessions.connectorBindingsInheritUnbound,
        createdByServiceAccountId: serviceAccounts.serviceAccountId,
      })
      .from(projectSessions)
      .leftJoin(
        serviceAccounts,
        and(
          eq(serviceAccounts.serviceAccountId, projectSessions.createdBy),
          eq(serviceAccounts.accountId, projectSessions.accountId),
        ),
      )
      .where(
        and(
          eq(projectSessions.sessionId, sessionId),
          eq(projectSessions.accountId, accountId),
          eq(projectSessions.projectId, projectId),
        ),
      )
      .limit(1);
    return session ?? null;
  });
}

/**
 * Drop the request-scoped session lookup memo. Call this after any write that
 * changes what it reads (`project_sessions.connector_bindings_configured` /
 * `.connector_bindings_inherit_unbound`) so a re-resolution later in the SAME
 * request observes the write instead of the pre-write cached row.
 */
export function invalidateSessionConnectorLookup(sessionId: string, accountId: string, projectId: string): void {
  invalidateRequestMemo(sessionConnectorLookupMemoKey(sessionId, accountId, projectId));
}

/**
 * Resolve the effective connection on every connector request. A present but
 * revoked/error binding never falls through to a project default.
 *
 * Returns the full outcome (see `ResolvedConnectorConnectionOutcome`) so a
 * caller that must distinguish "nothing reachable" from "several reachable
 * accounts and none named or pinned" — the gateway's `account_required`
 * denial — can. `resolveSessionConnectorConnection` below is a thin wrapper
 * for the many callers that only ever asked "did this resolve".
 *
 * A session PIN (an explicit `projectSessionConnectorBindings` row) is never
 * ambiguous — it is the caller's own prior explicit choice, so it resolves
 * directly (`ok`) or fails closed (`none`) exactly as before; only the
 * project-default FALLBACK (no binding, or an inherit-unbound session) can
 * ever return `ambiguous`.
 */
export async function resolveSessionConnectorConnectionOutcome(input: {
  accountId: string;
  projectId: string;
  sessionId: string | null;
  alias: string;
  actingUserId?: string;
  actingPrincipalIsServiceAccount?: boolean;
  /**
   * Present when the caller is an agent session under the agent-principal
   * model. A member-owned account then keys on `onBehalfOfUserId` AND a private
   * session — never on the session creator or the token user.
   */
  agentPrincipal?: AgentPrincipalPersonalScope | null;
  /**
   * Name or id of the account to run this call as, when the caller named one.
   * Omitted resolves exactly as before: the session's binding if it holds one,
   * otherwise the project-default resolution rule (see
   * `selectEntitledConnectorConnection`).
   *
   * A NAMED account is never silently substituted. It is matched against the
   * accounts this caller is entitled to and, failing that, the call is denied —
   * running "send mail as Work" against Personal is worse than not running.
   */
  account?: string | null;
}): Promise<ResolvedConnectorConnectionOutcome> {
  const alias = canonicalConnectorAlias(input.alias);
  let actingUserId = input.actingUserId ?? '';
  let actingPrincipalIsServiceAccount = input.actingPrincipalIsServiceAccount ?? false;
  let visibility: 'private' | 'project' | 'restricted' = 'private';
  let connectorBindingsConfigured = false;
  let inheritUnbound = false;

  if (input.sessionId) {
    const session = await loadSessionConnectorLookup(input.sessionId, input.accountId, input.projectId);
    if (!session) return { kind: 'none' };
    actingUserId = session.createdBy ?? '';
    actingPrincipalIsServiceAccount = session.createdByServiceAccountId !== null;
    visibility = session.visibility;
    connectorBindingsConfigured = session.bindingsConfigured;
    inheritUnbound = session.inheritUnbound;

    const [bound] = await db
      .select({
        ...boundConnectionSelect(),
        connectionLabel: connectorConnections.label,
        source: projectSessionConnectorBindings.source,
      })
      .from(projectSessionConnectorBindings)
      .innerJoin(
        connectorConnections,
        eq(connectorConnections.connectionId, projectSessionConnectorBindings.connectionId),
      )
      .innerJoin(
        connectors,
        and(
          eq(connectors.connectorId, projectSessionConnectorBindings.connectorId),
          eq(connectors.accountId, projectSessionConnectorBindings.accountId),
          eq(connectors.projectId, projectSessionConnectorBindings.projectId),
        ),
      )
      .where(
        and(
          eq(projectSessionConnectorBindings.sessionId, input.sessionId),
          eq(projectSessionConnectorBindings.accountId, input.accountId),
          eq(projectSessionConnectorBindings.projectId, input.projectId),
          eq(projectSessionConnectorBindings.connectorAlias, alias),
        ),
      )
      .limit(1);
    if (bound) {
      const connector: ConnectorRequirementRow = {
        connectorId: bound.connectorId,
        projectId: input.projectId,
        slug: alias,
        name: bound.connectorName,
        providerType: bound.providerType,
        config: bound.connectorConfig,
        enabled: bound.connectorEnabled,
        status: bound.connectorStatus,
      };
      const connection: ConnectorConnectionRow = {
        connectionId: bound.connectionId,
        isDefault: bound.isDefault,
        ownerType: bound.ownerType,
        ownerId: bound.ownerId,
        status: bound.connectionStatus,
        metadata: bound.metadata,
      };
      const audience = (
        await loadConnectionAudience({
          projectId: input.projectId,
          accountId: input.accountId,
          userId: audiencePersonId({
            actingUserId,
            actingPrincipalIsServiceAccount,
            agentPrincipal: input.agentPrincipal,
          }),
          agentId: input.agentPrincipal?.agentId ?? null,
        })
      )(connection.connectionId);
      if (
        !connector.enabled ||
        connector.status !== 'active' ||
        connection.status !== 'active' ||
        (connectionNeedsPrivateSession(connection.ownerType, audience) && visibility !== 'private') ||
        !sessionConnectionIsReachable(
          connector,
          connection,
          {
            userId: actingUserId,
            isServiceAccount: actingPrincipalIsServiceAccount,
            agentPrincipal: input.agentPrincipal
              ? { onBehalfOfUserId: input.agentPrincipal.onBehalfOfUserId, agentId: input.agentPrincipal.agentId ?? null, visibility }
              : null,
          },
          audience,
        ) ||
        !(await connectorConnectionIsConnected({ connector, connection }))
      ) {
        return { kind: 'none' };
      }
      // A session that PINNED an account is a constraint, not a suggestion. A
      // call that names a different one is denied rather than quietly run
      // against the pinned account — the caller asked for a specific mailbox.
      if (input.account?.trim() && !boundConnectionAnswersTo(input.account, bound)) {
        return { kind: 'none' };
      }
      return {
        kind: 'ok',
        connection: {
          connectionId: bound.connectionId,
          connectorId: bound.connectorId,
          status: bound.connectionStatus,
          isDefault: bound.isDefault,
          source: bound.source,
          alias,
          metadata: bound.metadata ?? {},
          label: bound.connectionLabel,
          ownerType: bound.ownerType,
        },
      };
    }
    if (connectorBindingsConfigured && !inheritUnbound) return { kind: 'none' };
  }

  // Hand the project-default fallback the SAME principal identity the original
  // inlined branch used: when a session is in scope, the session-resolved
  // service-account flag (line 715) is authoritative and detection must NOT
  // re-run (the original skipped it when `input.sessionId` was set). When no
  // session is in scope, pass the RAW caller value so the helper's
  // `=== undefined` detection runs exactly as before.
  return resolveProjectDefaultConnectorConnectionOutcome({
    accountId: input.accountId,
    projectId: input.projectId,
    alias,
    actingUserId,
    actingPrincipalIsServiceAccount: input.sessionId
      ? actingPrincipalIsServiceAccount
      : input.actingPrincipalIsServiceAccount,
    visibility,
    account: input.account,
    agentPrincipal: input.agentPrincipal ?? null,
  });
}

/** `resolveSessionConnectorConnectionOutcome`, collapsed to the pre-existing
 *  `T | null` shape for the many callers that only ever asked "did this
 *  resolve" — `ambiguous` collapses to `null` here exactly like "nothing
 *  reachable" did before this rule existed; a caller that must tell them
 *  apart (the gateway's `account_required` denial) uses the outcome-returning
 *  sibling above directly. */
export async function resolveSessionConnectorConnection(
  input: Parameters<typeof resolveSessionConnectorConnectionOutcome>[0],
): Promise<ResolvedSessionConnectorConnection | null> {
  const outcome = await resolveSessionConnectorConnectionOutcome(input);
  return outcome.kind === 'ok' ? outcome.connection : null;
}
