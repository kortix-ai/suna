import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { logger as appLogger } from '../lib/logger';
import { db } from '../shared/db';
import { projectSessionMetadataMerge } from './lib/session-metadata-merge';

/**
 * `metadata.last_activity_at` — when a user or agent turn was last accepted for
 * a session. The sidebar's Today / Yesterday / This week / Older sections and
 * its "last activity" column both read it.
 *
 * It exists because neither pre-existing timestamp answers the question:
 *
 *   - `project_sessions.updated_at` is bookkeeping. Runtime stop/resume, title
 *     sync, branch telemetry, and mapping repairs all advance it with no turn
 *     behind them, so an idle session drifts to the top of the list.
 *   - `metadata.runtime_sessions[].updated_at` is real conversation activity,
 *     but it is a CACHE of the runtime's state document, written each time a
 *     projection is stored (`writeRuntimeSessionList`). The box may be
 *     unreachable and the root may not resolve, so it can be missing. Before
 *     R7.4 it was also a timer the API pod could recycle inside. When it never
 *     lands the session has no activity record at all, and the sidebar falls
 *     back to its CREATION date — which is how a session used every day
 *     stayed pinned to "Older".
 *
 * This stamp is written from the one place that already knows a turn is real:
 * the preview proxy, after the prompt dedupe claim succeeds. It touches only
 * the database, so it cannot fail for any of the reasons the snapshot does.
 */
export const SESSION_LAST_ACTIVITY_KEY = 'last_activity_at';

/**
 * Record that a session accepted a turn.
 *
 * Merged in-SQL (never a read-modify-write) because this runs alongside the
 * title CAS and the snapshot sync, which write other keys of the same jsonb
 * column — see session-metadata-merge.ts.
 *
 * Best-effort and never awaited by the prompt path: a failed stamp degrades the
 * sidebar's ordering, and must never degrade the prompt.
 */
export async function recordSessionActivity(input: {
  sessionId: string;
  projectId: string;
  /** Epoch ms. Defaults to now; injectable so tests need no clock control. */
  at?: number;
}): Promise<void> {
  if (!input.sessionId || !input.projectId) return;
  const at = new Date(input.at ?? Date.now()).toISOString();
  try {
    await db
      .update(projectSessions)
      .set({
        metadata: projectSessionMetadataMerge({ [SESSION_LAST_ACTIVITY_KEY]: at }),
        updatedAt: new Date(at),
      })
      .where(
        and(
          eq(projectSessions.sessionId, input.sessionId),
          eq(projectSessions.projectId, input.projectId),
        ),
      );
  } catch (err) {
    appLogger.warn('[session-activity] failed to stamp last activity', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
