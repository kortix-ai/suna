/**
 * `active_child_agent` on a space's thread list: the agent of a direct child
 * session of the thread that is working right now (a router's hidden worker),
 * newest first, or null. The main chat's reply line says "<Agent> is
 * working" from it while the thread's own turn has ended ("On it.").
 *
 * Working means what it means everywhere (`readSessionsWorking`). Only direct
 * children updated in the last day are read: a thread's live workers are
 * recent, and a long thread's old children cost nothing.
 */
import type { SessionWorking } from '@kortix/api-contract';
import { projectSessions } from '@kortix/db';
import { and, gt, inArray } from 'drizzle-orm';

import { db } from '../../shared/db';
import { readSessionsWorking } from './session-working-read';

const RECENT_MS = 24 * 60 * 60 * 1000;

export interface ChildRow {
  sessionId: string;
  parentSessionId: string;
  agentName: string | null;
  updatedAt: Date;
}

/** Each parent's newest working child's agent (pure). A child with no agent name is skipped. */
export function activeChildAgents(children: readonly ChildRow[], working: ReadonlyMap<string, SessionWorking>): Map<string, string> {
  const newest = new Map<string, ChildRow>();
  for (const child of children) {
    if (!child.agentName || working.get(child.sessionId)?.state !== 'working') continue;
    const seen = newest.get(child.parentSessionId);
    if (!seen || child.updatedAt > seen.updatedAt) newest.set(child.parentSessionId, child);
  }
  return new Map([...newest].map(([parent, child]) => [parent, child.agentName!]));
}

/** Call only after visibility/pagination, with the threads the caller may see. */
export async function readActiveChildAgents(threadIds: string[], now = Date.now()): Promise<Map<string, string>> {
  if (threadIds.length === 0) return new Map();
  const children = (await db
    .select({
      sessionId: projectSessions.sessionId,
      parentSessionId: projectSessions.parentSessionId,
      agentName: projectSessions.agentName,
      updatedAt: projectSessions.updatedAt,
    })
    .from(projectSessions)
    .where(
      and(
        inArray(projectSessions.parentSessionId, threadIds),
        gt(projectSessions.updatedAt, new Date(now - RECENT_MS)),
      ),
    )) as ChildRow[];
  if (children.length === 0) return new Map();
  const working = await readSessionsWorking(children.map((child) => child.sessionId));
  return activeChildAgents(children, working);
}
