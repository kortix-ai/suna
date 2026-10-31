/**
 * Does a running turn wait on a person, and does anybody attend its session?
 * The reaper's two questions for a turn that renews nothing while it waits
 * (KRTX-1739, `holdWaitingTurn` in box-reaper.ts).
 */
import type { RuntimePending } from '@kortix/api-contract/runtime-relay';
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { fetchRuntimePending, fetchRuntimeState, runtimeDaemonEndpoint } from '../lib/session-runtime-transport';
import { runtimeServesLog } from '../session-lifecycle/runtime-fetch';
import { isUnattendedSession } from '../session-lifecycle/unattended-runtime-recovery';

/** What a turn waits on when it waits on a person. */
export type TurnWait = 'permission' | 'question';

/** The turn waits on a person, still works (`none`), or this read cannot tell. */
export type TurnWaitReading = TurnWait | 'none' | 'unknown';

/** `/kortix/runtime/state` status types that mean a conversation is running. */
const RUNNING_STATUSES = new Set(['busy', 'retry']);
/** A parent chain longer than this is a cycle, not a task tree. */
const MAX_TREE_DEPTH = 64;

/** One `Known<T>` section of the `/kortix/runtime/state` document, or `null` when unread. */
function knownSection(section: unknown): unknown {
  const known = section as { known?: unknown; value?: unknown } | undefined;
  return known?.known === true ? known.value : null;
}

/** One open ask: the conversation it sits on, and what it asks for. */
interface TurnAsk {
  conversationId: string;
  kind: TurnWait;
}

/**
 * The waiting rule, over any runtime's reading. The turn waits on a person when
 * an open ask sits on a running conversation in `rootId`'s tree, AND every
 * running conversation in the tree holds such an ask or is an ancestor of one.
 * A running conversation outside that set still works, so the turn does not
 * wait. An ask on a conversation that is not running is a stale entry (a lost
 * `replied` frame) and does not count.
 */
function waitingRule(
  rootId: string,
  asks: TurnAsk[],
  runningIds: Iterable<string>,
  parentOf: (id: string) => string | undefined,
): TurnWait | 'none' {
  const running = new Set(runningIds);
  /** `id` and each ancestor, up to the first conversation with no parent. */
  const chain = (id: string): string[] => {
    const ids = [id];
    for (let parent = parentOf(id); parent && ids.length < MAX_TREE_DEPTH; parent = parentOf(parent)) {
      ids.push(parent);
    }
    return ids;
  };
  const askers = new Map<string, TurnWait>();
  for (const ask of asks) {
    if (running.has(ask.conversationId) && chain(ask.conversationId).includes(rootId)) {
      askers.set(ask.conversationId, ask.kind);
    }
  }
  if (askers.size === 0) return 'none';
  const blocked = new Set([...askers.keys()].flatMap(chain));
  for (const id of running) {
    if (chain(id).includes(rootId) && !blocked.has(id)) return 'none';
  }
  return [...askers.values()].includes('permission') ? 'permission' : 'question';
}

/**
 * What the turn on the runtime conversation `rootId` waits on, read from a
 * `/kortix/runtime/state` document (a box that does not serve its session log).
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

  const parents = new Map<string, string>();
  for (const session of sessions) {
    const { id, parent_id: parentId } = (session ?? {}) as { id?: unknown; parent_id?: unknown };
    if (typeof id === 'string' && typeof parentId === 'string') parents.set(id, parentId);
  }
  const running = Object.entries(statuses as Record<string, { type?: unknown } | undefined>)
    .filter(([, status]) => typeof status?.type === 'string' && RUNNING_STATUSES.has(status.type))
    .map(([id]) => id);
  const asks: TurnAsk[] = [];
  for (const [kind, list] of [['question', questions], ['permission', permissions]] as const) {
    for (const ask of list) {
      const conversationId = (ask as { sessionID?: unknown } | null)?.sessionID;
      if (typeof conversationId === 'string') asks.push({ conversationId, kind });
    }
  }
  return waitingRule(rootId, asks, running, (id) => parents.get(id));
}

/**
 * The same reading from `GET /kortix/runtime/pending`, on a box that serves its
 * session log (`runtime.log.v1`). The answer covers one session: its root
 * thread `rootId` and its subagent threads, each a child of the root (pi files
 * every subagent under the root). `busy` and `compacting` threads run.
 *
 * `unknown` when the answer does not have the `RuntimePending` shape.
 */
export function turnWaitingInPending(pending: unknown, rootId: string): TurnWaitReading {
  const { statuses, permissions, questions } = (pending ?? {}) as Partial<Record<keyof RuntimePending, unknown>>;
  if (!Array.isArray(permissions) || !Array.isArray(questions)) return 'unknown';
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return 'unknown';
  const running = Object.entries(statuses as Record<string, unknown>)
    .filter(([, status]) => status === 'busy' || status === 'compacting')
    .map(([id]) => id);
  const asks: TurnAsk[] = [];
  for (const [kind, list] of [['question', questions], ['permission', permissions]] as const) {
    for (const ask of list) {
      const conversationId = (ask as { thread_id?: unknown } | null)?.thread_id;
      if (typeof conversationId === 'string') asks.push({ conversationId, kind });
    }
  }
  return waitingRule(rootId, asks, running, (id) => (id === rootId ? undefined : rootId));
}

/** Ask the daemon whether the turn on `runtimeSessionId` waits on a person. Never throws. */
export async function observeTurnWaiting(
  externalId: string,
  runtimeSessionId: string,
): Promise<TurnWaitReading> {
  const target = { externalId };
  if (await runtimeServesLog(externalId, () => runtimeDaemonEndpoint(target))) {
    const pending = await fetchRuntimePending(target);
    return pending.ok ? turnWaitingInPending(pending.body, runtimeSessionId) : 'unknown';
  }
  const state = await fetchRuntimeState(target);
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
