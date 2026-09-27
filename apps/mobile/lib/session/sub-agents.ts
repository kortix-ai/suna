/**
 * sub-agents — which project sessions are sub-agents of which (COR-162).
 *
 * One relation for the whole app. A sub-agent session is a project session
 * spawned by another project session: `metadata.spawned_by_session`, read
 * through `sessionParentId` from `@kortix/sdk` (it rejects a non-string value
 * and a session that names itself). The session list nests by the same
 * relation (`groupSessionsByCoordinator`, `session-list.ts`), so the list and
 * the thread header always agree on what a sub-agent is.
 *
 * OpenCode's own sub-session tree (`parentID` / `opencode_sessions[].parent_id`)
 * is a different thing and is not read here.
 *
 * The rows are the project's session list (`useProjectSessions`), already
 * fetched by `ProjectScreen`: no extra request.
 *
 * Pure data and pure functions only. No React, no React Native, no expo —
 * this module is unit-tested under `bun test`.
 */
import { sessionParentId } from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';
import { sessionDisplayTitle, sessionLastActivityAt } from './session-list';

/**
 * The project session that spawned `session`, or `null` when nothing spawned
 * it or its parent is not in `sessions` (deleted, or not loaded).
 */
export function parentSessionOf(
  session: ProjectSession | null | undefined,
  sessions: readonly ProjectSession[],
): ProjectSession | null {
  if (!session) return null;
  const parentId = sessionParentId(session);
  if (!parentId) return null;
  return sessions.find((row) => row.session_id === parentId) ?? null;
}

/**
 * The project sessions `sessionId` spawned directly, newest activity first
 * (`sessionLastActivityAt`, the list's own order). Ties break on
 * `session_id`, so the order is stable between polls.
 */
export function subAgentsOf(sessionId: string, sessions: readonly ProjectSession[]): ProjectSession[] {
  return sessions
    .filter((row) => sessionParentId(row) === sessionId)
    .map((row) => ({ row, at: sessionLastActivityAt(row) }))
    .sort((a, b) => b.at - a.at || a.row.session_id.localeCompare(b.row.session_id))
    .map((entry) => entry.row);
}

/**
 * What the thread header shows: a link up to the parent session, or a count
 * of this session's sub-agents. A sub-agent that spawned its own sub-agents
 * shows the parent link — the way back is the move the reader most likely
 * makes next.
 */
export type SubAgentRelation =
  | { type: 'child'; parent: ProjectSession; parentTitle: string }
  | { type: 'parent'; count: number };

/** `null` when `session` has no resolvable parent and no sub-agents. */
export function subAgentRelation(
  session: ProjectSession | null | undefined,
  sessions: readonly ProjectSession[],
): SubAgentRelation | null {
  if (!session) return null;
  const parent = parentSessionOf(session, sessions);
  if (parent) return { type: 'child', parent, parentTitle: sessionDisplayTitle(parent) };

  const count = subAgentsOf(session.session_id, sessions).length;
  return count > 0 ? { type: 'parent', count } : null;
}
