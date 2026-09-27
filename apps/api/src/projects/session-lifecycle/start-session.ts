/** `/start`: open a session's runtime, optionally long-polling until it is ready. */

import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { openSession } from '../routes/shared';
import { awaitTerminalStage } from './await-stage';
import type { SessionLifecycleResult, StartSessionCommand } from './types';

export async function startSession(command: StartSessionCommand) {
  const first = await openSession({
    loaded: command.loaded,
    visible: command.visible,
    projectId: command.projectId,
    sessionId: command.sessionId,
  });
  // Optional long-poll: re-resolve (re-reading the live session row each tick,
  // like continueSession) until ready/terminal or the bounded deadline, so the
  // client learns `ready` immediately instead of on its ~800ms poll tick.
  // waitMs<=0 or an already-terminal first result → returns `first` unchanged,
  // so the immediate-ready path and every non-long-poll caller are untouched.
  const start = await awaitTerminalStage(
    first,
    async () => {
      const [fresh] = await db
        .select({
          status: projectSessions.status,
          sandboxProvider: projectSessions.sandboxProvider,
          baseRef: projectSessions.baseRef,
          agentName: projectSessions.agentName,
          opencodeSessionId: projectSessions.opencodeSessionId,
          accountId: projectSessions.accountId,
          metadata: projectSessions.metadata,
        })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, command.sessionId))
        .limit(1);
      if (!fresh) return null;
      return openSession({
        loaded: command.loaded,
        visible: { row: fresh },
        projectId: command.projectId,
        sessionId: command.sessionId,
      });
    },
    { waitMs: command.waitMs ?? 0 },
  );
  return {
    status: start.stage === 'ready' ? 'ready' : 'pending',
    sessionId: command.sessionId,
    start,
    retryable: start.retriable,
  } satisfies SessionLifecycleResult;
}
