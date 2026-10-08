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

/** One `Known<T>` section of the `/kortix/runtime/state` document. */
function knownList(section: unknown): unknown[] | null {
  const known = section as { known?: unknown; value?: unknown } | undefined;
  return known?.known === true && Array.isArray(known.value) ? known.value : null;
}

/**
 * What the turn on the runtime conversation `rootId` waits on, read from a
 * `/kortix/runtime/state` document (both harnesses serve it): an open
 * permission ask or question on that conversation or on a sub-agent
 * conversation under it. `null` for nothing, and for a section the daemon
 * could not read, so the caller keeps renewing as before.
 */
export function turnWaitingIn(doc: Record<string, unknown>, rootId: string): TurnWait | null {
  const tree = new Set([rootId]);
  const sessions = (knownList(doc.sessions) ?? []) as Array<{ id?: unknown; parent_id?: unknown }>;
  // A task inside a task is a grandchild: add children until none joins.
  for (let grew = true; grew; ) {
    grew = false;
    for (const session of sessions) {
      if (
        typeof session?.id === 'string' &&
        typeof session.parent_id === 'string' &&
        tree.has(session.parent_id) &&
        !tree.has(session.id)
      ) {
        tree.add(session.id);
        grew = true;
      }
    }
  }
  const asksIn = (section: unknown) =>
    (knownList(section) ?? []).some((ask) => {
      const sessionId = (ask as { sessionID?: unknown } | null)?.sessionID;
      return typeof sessionId === 'string' && tree.has(sessionId);
    });
  if (asksIn(doc.permissions)) return 'permission';
  if (asksIn(doc.questions)) return 'question';
  return null;
}

/** Ask the daemon whether the turn on `runtimeSessionId` waits on a person. Never throws. */
export async function observeTurnWaiting(
  externalId: string,
  runtimeSessionId: string,
): Promise<TurnWait | null> {
  const state = await fetchRuntimeState({ externalId });
  return state.ok && state.status === 200 ? turnWaitingIn(state.doc, runtimeSessionId) : null;
}

/** Is nobody a person waiting on this session's page? One primary-key read. */
export async function sessionIsUnattended(sessionId: string): Promise<boolean> {
  const [session] = await db
    .select({ origin: projectSessions.origin, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return session
    ? isUnattendedSession({
        origin: session.origin,
        metadata: session.metadata as Record<string, unknown> | null,
      })
    : false;
}
