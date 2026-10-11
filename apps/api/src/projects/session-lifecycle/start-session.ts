/** `/start`: open a session's runtime, optionally long-polling until it is ready. */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { healSupersededSessionToken } from '../lib/heal-session-token';
import { openSession } from '../session-open';
import type { OpenSessionRow } from '../session-open/session-open-context';
import { awaitTerminalStage } from './await-stage';
import type { SessionLifecycleResult, StartSessionCommand } from './types';

/**
 * The session row and its sandbox row, read in ONE statement.
 *
 * Every long-poll tick of `/start` re-resolves both (the session row's status
 * can flip under a concurrent stop/delete; the sandbox row is what the open
 * orchestrator acts on). Two separate selects per tick at a 200 ms cadence
 * measured 168 db statements on one 15 s boot wait (2026-10-09, local stack);
 * the joined read is what halves the per-tick fan-out.
 */
async function readSessionRuntimePair(
  sessionId: string,
): Promise<{ session: StartSessionCommand['visible']['row'] | null; sandbox: OpenSessionRow | null }> {
  const [pair] = await db
    .select({
      status: projectSessions.status,
      sandboxProvider: projectSessions.sandboxProvider,
      baseRef: projectSessions.baseRef,
      agentName: projectSessions.agentName,
      runtimeSessionId: projectSessions.runtimeSessionId,
      accountId: projectSessions.accountId,
      metadata: projectSessions.metadata,
      sandbox: sessionSandboxes,
    })
    .from(projectSessions)
    .leftJoin(
      sessionSandboxes,
      and(
        eq(sessionSandboxes.sessionId, projectSessions.sessionId),
        eq(sessionSandboxes.projectId, projectSessions.projectId),
        eq(sessionSandboxes.accountId, projectSessions.accountId),
      ),
    )
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!pair) return { session: null, sandbox: null };
  const { sandbox, ...session } = pair;
  return { session, sandbox };
}

export async function startSession(command: StartSessionCommand) {
  // The instant this open was asked for. Every long-poll tick below carries it:
  // a user Stop that lands while the request waits wins over the request
  // (`userStopFollowsIntent`), instead of the next tick waking the box again.
  const wakeIntentAt = command.wakeIntentAt ?? new Date();
  // ONE joined read feeds the token heal, the first open, and — fresh every
  // tick — the long-poll re-resolve. `healSupersededSessionToken` used to
  // probe the sandbox row for its config and `openSession` re-read the same
  // row milliseconds later: two statements per `/start` that this read
  // replaces.
  const preloaded = await readSessionRuntimePair(command.sessionId);
  if (preloaded.session) {
    // Before the box wakes: its daemon claims its first turn with the token the
    // provider injected, and that token may have been revoked while the box kept it.
    await healSupersededSessionToken(command.sessionId, preloaded.sandbox ?? undefined);
  }
  const first = await openSession({
    loaded: command.loaded,
    visible: command.visible,
    projectId: command.projectId,
    sessionId: command.sessionId,
    keepStopped: command.keepStopped,
    wakeIntentAt,
    preloadedSandboxRow: preloaded.sandbox,
  });
  // Optional long-poll: re-resolve (re-reading the live session row each tick,
  // like continueSession) until ready/terminal or the bounded deadline, so the
  // client learns `ready` immediately instead of on its ~800ms poll tick.
  // waitMs<=0 or an already-terminal first result → returns `first` unchanged,
  // so the immediate-ready path and every non-long-poll caller are untouched.
  //
  // A tick that saw a Stop in progress (`runtime_stopping`) makes the rest of
  // the wait a keep-alive poll: this request arrived while the user was
  // stopping the box, so it may report the stop, never undo it once it lands.
  let sawStopInProgress = first.reason === 'runtime_stopping';
  const start = await awaitTerminalStage(
    first,
    async () => {
      const fresh = await readSessionRuntimePair(command.sessionId);
      if (!fresh.session) return null;
      const next = await openSession({
        loaded: command.loaded,
        visible: { row: fresh.session },
        projectId: command.projectId,
        sessionId: command.sessionId,
        keepStopped: command.keepStopped || sawStopInProgress,
        wakeIntentAt,
        preloadedSandboxRow: fresh.sandbox,
      });
      if (next.reason === 'runtime_stopping') sawStopInProgress = true;
      return next;
    },
    { waitMs: command.waitMs ?? 0, signal: command.signal },
  );
  return {
    status: start.stage === 'ready' ? 'ready' : 'pending',
    sessionId: command.sessionId,
    start,
    retryable: start.retriable,
  } satisfies SessionLifecycleResult;
}
