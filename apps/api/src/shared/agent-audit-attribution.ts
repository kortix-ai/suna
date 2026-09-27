/**
 * Audit attribution for an agent-session credential — spec
 * docs/specs/2026-09-22-agents-as-principals.md §2:
 *
 *   actor = agent (agent_name, agent_id = its service account)
 *   on_behalf_of = the human | null
 *   initiator = human | trigger | channel | system
 *
 * Every audit writer that sees an agent-session credential (the API request
 * middleware, the Git proxy, the sandbox OpenCode ingestion) resolves the SAME
 * attribution here, so one session reads the same way on every row.
 */
import { and, eq } from 'drizzle-orm';
import { projectSessions, serviceAccounts } from '@kortix/db';
import { db } from './db';
import { ttlMemo } from './ttl-memo';

export type AgentAuditInitiatorType = 'human' | 'trigger' | 'channel' | 'system';

/** `project_sessions.metadata.source` values that name a channel platform. */
const CHANNEL_SOURCES: ReadonlySet<string> = new Set(['slack', 'teams', 'email', 'telegram']);
const TRIGGER_ORIGINS: ReadonlySet<string> = new Set(['trigger', 'schedule']);

export interface AgentAuditSessionFacts {
  origin: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdByIsServiceAccount: boolean;
}

/**
 * Who started the work. Order:
 *   1. on_behalf_of set → that human (a Slack/Teams message from a linked user
 *      included: the human is the initiator, the channel only carried it).
 *   2. trigger metadata / trigger origin → `trigger`, named by its slug.
 *   3. a channel source → `channel`, named by the platform.
 *   4. a human creator (a private session whose on_behalf_of another human's
 *      prompt cleared) → that creator.
 *   5. anything else → `system`: a backend service account (named by its id)
 *      or an unknown session (no id).
 */
export function agentAuditInitiator(input: {
  onBehalfOfUserId: string | null;
  session: AgentAuditSessionFacts | null;
}): { type: AgentAuditInitiatorType; id: string | null } {
  if (input.onBehalfOfUserId) return { type: 'human', id: input.onBehalfOfUserId };
  const session = input.session;
  if (!session) return { type: 'system', id: null };
  const meta = session.metadata ?? {};
  if (
    meta.trigger_kind != null ||
    meta.trigger_slug != null ||
    meta.trigger_source != null ||
    (session.origin != null && TRIGGER_ORIGINS.has(session.origin))
  ) {
    return { type: 'trigger', id: typeof meta.trigger_slug === 'string' ? meta.trigger_slug : null };
  }
  if (typeof meta.source === 'string' && CHANNEL_SOURCES.has(meta.source)) {
    return { type: 'channel', id: meta.source };
  }
  if (session.createdBy && !session.createdByIsServiceAccount) return { type: 'human', id: session.createdBy };
  // A backend service account keeps its id on the row; it is not a human.
  return { type: 'system', id: session.createdByIsServiceAccount ? session.createdBy : null };
}

/**
 * `actor_user_id` of an agent-session row. Legacy (flag OFF / ungoverned):
 * the token user, unchanged — it IS the authority. Agent principal: the actor
 * is the agent, so the only human on the row is the on-behalf-of human; an
 * unattended run names none (never the account-owner stand-in).
 */
export function agentAuditActorUserId(input: {
  agentPrincipal: boolean;
  tokenUserId: string | null;
  onBehalfOfUserId: string | null;
}): string | null {
  return input.agentPrincipal ? input.onBehalfOfUserId : input.tokenUserId;
}

/**
 * The session facts the initiator needs. Trigger/channel metadata and the
 * creator are fixed at create, so a 60 s positive memo keeps the per-request
 * cost at one indexed read per session per minute per replica.
 */
export const loadAgentAuditSessionFacts = ttlMemo({
  ttlMs: 60_000,
  keyFn: (sessionId: string) => sessionId,
  loader: async (sessionId: string): Promise<(AgentAuditSessionFacts & { agentName: string | null }) | null> => {
    const [row] = await db
      .select({
        origin: projectSessions.origin,
        metadata: projectSessions.metadata,
        createdBy: projectSessions.createdBy,
        agentName: projectSessions.agentName,
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
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!row) return null;
    return {
      origin: row.origin ?? null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdBy: row.createdBy ?? null,
      createdByIsServiceAccount: row.createdByServiceAccountId != null,
      agentName: row.agentName ?? null,
    };
  },
  shouldCache: (row) => row !== null,
});

export interface AgentAuditAttribution {
  actorUserId: string | null;
  /** The agent's service account; null for a legacy sandbox key. */
  agentId: string | null;
  agentName: string | null;
  onBehalfOfUserId: string | null;
  initiatorActorType: AgentAuditInitiatorType;
  initiatorActorId: string | null;
}

/**
 * Full attribution for one agent-session credential. A session read failure
 * degrades the initiator to `system`; it never fails the audited request.
 */
export async function resolveAgentAuditAttribution(input: {
  sessionId: string | null;
  serviceAccountId: string | null;
  agentName: string | null;
  agentPrincipal: boolean;
  tokenUserId: string | null;
  onBehalfOfUserId: string | null;
}): Promise<AgentAuditAttribution> {
  let facts: Awaited<ReturnType<typeof loadAgentAuditSessionFacts>> = null;
  if (input.sessionId) {
    try {
      facts = await loadAgentAuditSessionFacts(input.sessionId);
    } catch {
      facts = null;
    }
  }
  const initiator = agentAuditInitiator({ onBehalfOfUserId: input.onBehalfOfUserId, session: facts });
  return {
    actorUserId: agentAuditActorUserId({
      agentPrincipal: input.agentPrincipal,
      tokenUserId: input.tokenUserId,
      onBehalfOfUserId: input.onBehalfOfUserId,
    }),
    agentId: input.serviceAccountId,
    agentName: input.agentName ?? facts?.agentName ?? null,
    onBehalfOfUserId: input.onBehalfOfUserId,
    initiatorActorType: initiator.type,
    initiatorActorId: initiator.id,
  };
}
