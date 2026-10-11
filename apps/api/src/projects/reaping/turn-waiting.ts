/**
 * Does a running turn wait on a person, and does anybody attend its session?
 * The reaper's two questions for a turn that renews nothing while it waits
 * (KRTX-1739, `holdWaitingTurn` in box-reaper.ts).
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { fetchRuntimeState } from '../lib/session-runtime-transport';
import { isUnattendedSession } from '../session-lifecycle/unattended-runtime-recovery';

/** What a turn waits on when it waits on a person. */
export type TurnWait = 'permission' | 'question';

/** The turn waits on a person, still works (`none`), or this read cannot tell. */
export type TurnWaitReading = TurnWait | 'none' | 'unknown';

/** OpenCode `/session/status` types that mean a conversation is running. */
const RUNNING_STATUSES = new Set(['busy', 'retry']);
/** A parent chain longer than this is a cycle, not a task tree. */
const MAX_TREE_DEPTH = 64;

/** One `Known<T>` section of the `/kortix/runtime/state` document, or `null` when unread. */
function knownSection(section: unknown): unknown {
  const known = section as { known?: unknown; value?: unknown } | undefined;
  return known?.known === true ? known.value : null;
}

/**
 * What the turn on the runtime conversation `rootId` waits on, read from a
 * `/kortix/runtime/state` document (both harnesses serve it).
 *
 * The turn waits on a person when an open permission ask or question sits on
 * that conversation or a sub-agent conversation under it, AND every running
 * conversation in the tree holds such an ask or is an ancestor of one. A
 * running conversation outside that set is a sub-agent that still works, so
 * the turn does not wait. An ask on a conversation that is not running is a
 * stale entry (a lost `replied` frame) and does not count.
 *
 * `unknown` when the daemon could not read the asks, the statuses or the
 * conversation tree.
 */
export function turnWaitingIn(doc: Record<string, unknown>, rootId: string): TurnWaitReading {
  const permissions = knownSection(doc.permissions);
  const questions = knownSection(doc.questions);
  const statuses = knownSection(doc.statuses);
  const sessions = knownSection(doc.sessions);
  if (!Array.isArray(permissions) || !Array.isArray(questions) || !Array.isArray(sessions)) return 'unknown';
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return 'unknown';

  const parentOf = new Map<string, string>();
  for (const session of sessions) {
    const { id, parent_id: parentId } = (session ?? {}) as { id?: unknown; parent_id?: unknown };
    if (typeof id === 'string' && typeof parentId === 'string') parentOf.set(id, parentId);
  }
  /** `id` and each ancestor, up to the first conversation with no parent. */
  const chain = (id: string): string[] => {
    const ids = [id];
    for (let parent = parentOf.get(id); parent && ids.length < MAX_TREE_DEPTH; parent = parentOf.get(parent)) {
      ids.push(parent);
    }
    return ids;
  };
  const running = (id: string) => {
    const status = (statuses as Record<string, { type?: unknown } | undefined>)[id];
    return typeof status?.type === 'string' && RUNNING_STATUSES.has(status.type);
  };

  const askers = new Map<string, TurnWait>();
  for (const [kind, asks] of [['question', questions], ['permission', permissions]] as const) {
    for (const ask of asks) {
      const sessionId = (ask as { sessionID?: unknown } | null)?.sessionID;
      if (typeof sessionId === 'string' && running(sessionId) && chain(sessionId).includes(rootId)) {
        askers.set(sessionId, kind);
      }
    }
  }
  if (askers.size === 0) return 'none';
  const blocked = new Set([...askers.keys()].flatMap(chain));
  for (const id of Object.keys(statuses)) {
    if (running(id) && chain(id).includes(rootId) && !blocked.has(id)) return 'none';
  }
  return [...askers.values()].includes('permission') ? 'permission' : 'question';
}

/** Ask the daemon whether the turn on `runtimeSessionId` waits on a person. Never throws. */
export async function observeTurnWaiting(
  externalId: string,
  runtimeSessionId: string,
): Promise<TurnWaitReading> {
  const state = await fetchRuntimeState({ externalId });
  return state.ok && state.status === 200 ? turnWaitingIn(state.doc, runtimeSessionId) : 'unknown';
}

/**
 * Did a cron, schedule, trigger or system flow start this session? One
 * primary-key read. A worker session (`spawned_by_session`) is deliberately not
 * unattended here: its asks still push the person who started the coordinator,
 * and that person may answer.
 */
export async function sessionIsUnattended(sessionId: string): Promise<boolean> {
  const [session] = await db
    .select({ origin: projectSessions.origin })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return session ? isUnattendedSession({ origin: session.origin, metadata: null }) : false;
}
