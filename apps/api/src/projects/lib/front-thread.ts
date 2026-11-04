// The router (flag `chat_front`): a space thread whose My Kortix agent
// only talks. It routes each request to a hidden worker (any project agent,
// else My Kortix) and writes back like a person. kortixd reads the
// runtime_context key (`harness/pi/front.ts`, FRONT_CONTEXT_KEY).
import { projectSessionRuntimeContexts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
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
