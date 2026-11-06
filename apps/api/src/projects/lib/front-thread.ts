// The router (flag `chat_front`): a space thread whose My Kortix agent
// only talks. It routes each request to a hidden worker (any project agent,
// else My Kortix) and writes back like a person. kortixd reads the
// runtime_context key (`harness/pi/front.ts`, FRONT_CONTEXT_KEY).
import { projectSessionRuntimeContexts, projectSessions, projectSpaces } from '@kortix/db';
import { isMyKortixAgentName, MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { and, eq, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';

/** Session metadata a front carries, for clients. Server-managed: a request body cannot set it. */
export const FRONT_THREAD_METADATA_KEY = 'kortix_front';
/** The runtime_context key kortixd reads. Reserved (`kortix.`): only the platform sets it. */
export const FRONT_THREAD_CONTEXT_KEY = 'kortix.front';

/**
 * True when a new session starts as a front. Only server-side state decides:
 * both flags on, the session is filed in a space, it runs My Kortix, and it
 * is a top-level create (no session caller, no parent, no fork, no trigger run).
 */
export function startsFrontThread(input: {
  projectMetadata: unknown;
  spaceId: string | null;
  platformMetaAgent: boolean;
  callerSessionId: string | null | undefined;
  parentSessionId: unknown;
  forkFromSessionId: unknown;
  source: unknown;
}): boolean {
  if (!resolveFeatureFlag(input.projectMetadata, 'chat') || !resolveFeatureFlag(input.projectMetadata, 'chat_front')) {
    return false;
  }
  if (!input.spaceId || !input.platformMetaAgent || input.callerSessionId) return false;
  if (input.parentSessionId !== undefined || input.forkFromSessionId !== undefined) return false;
  return !(typeof input.source === 'string' && input.source.startsWith('trigger:'));
}

/**
 * True when this session is a front: its runtime_context carries
 * `kortix.front`, which only the platform sets. A front may start My Kortix
 * workers (the META_AGENT_RECURSION exception); a worker of any other
 * project agent is an ordinary hand-off.
 */
export async function sessionIsFrontThread(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({
      // The JSON true only: a string never casts, so no stored value can fail the read.
      front: sql<boolean>`coalesce(${projectSessionRuntimeContexts.context}->${FRONT_THREAD_CONTEXT_KEY} = 'true'::jsonb, false)`,
    })
    .from(projectSessionRuntimeContexts)
    .where(eq(projectSessionRuntimeContexts.sessionId, sessionId))
    .limit(1);
  return row?.front === true;
}

/**
 * A space's agents are a boundary (flag `chat`): the agents a router in this
 * session's space may hand work to, in order (the first is the default), or
 * null when the session is filed in no space. A channel: its agent list (an
 * empty list is returned as it is; the reader adds the project's default). The
 * person's own space (a DM): My Kortix, then the space's agents.
 */
export async function sessionSpaceAgents(sessionId: string): Promise<string[] | null> {
  const [row] = await db
    .select({ kind: projectSpaces.kind, agents: projectSpaces.agents, dmAgentName: projectSpaces.dmAgentName })
    .from(projectSessions)
    .innerJoin(projectSpaces, and(eq(projectSpaces.spaceId, projectSessions.spaceId), eq(projectSpaces.projectId, projectSessions.projectId)))
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return row ? spaceRowAgents(row) : null;
}

/** The agents of one space row (pure): a channel's list as it is; the person's own space leads with My Kortix. */
export function spaceRowAgents(row: { kind: string; agents: readonly string[] | null; dmAgentName: string | null }): string[] {
  const agents = [...(row.agents ?? [])];
  if (row.kind !== 'dm') return agents;
  const lead = row.dmAgentName && !isMyKortixAgentName(row.dmAgentName) ? row.dmAgentName : MY_KORTIX_AGENT_NAME;
  return [lead, ...agents.filter((name) => name.toLowerCase() !== lead.toLowerCase() && !(isMyKortixAgentName(name) && isMyKortixAgentName(lead)))];
}

/**
 * Whether a router of this space may hand work to `agent` (pure): one of the
 * space's agents, or, for a space with none, the project's default agent
 * (My Kortix when the project names none). Returns the roster for the refusal.
 */
export function spaceRosterAllows(
  spaceAgents: readonly string[],
  projectDefaultAgent: string | null,
  agent: string,
): { allowed: boolean; roster: string[] } {
  const roster = spaceAgents.length > 0 ? [...spaceAgents] : [projectDefaultAgent ?? MY_KORTIX_AGENT_NAME];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || (isMyKortixAgentName(a) && isMyKortixAgentName(b));
  return { allowed: roster.some((name) => same(name, agent)), roster };
}
