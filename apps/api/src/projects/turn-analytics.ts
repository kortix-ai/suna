/**
 * `turn_completed` product events, reported after the turn ledger recorded the
 * end (`completeSandboxTurn`). One event per ended turn, keyed on the turn
 * token. Only sessions a person started report: a trigger, channel or agent
 * session runs under a stand-in owner. Never throws, never delays the turn.
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { db } from '../shared/db';
import { captureProductEvent } from '../shared/product-analytics';

export interface EndedTurnForAnalytics {
  token: string;
  startedAtMs: number | null;
}

export async function reportTurnsCompleted(
  owner: { sessionId: string; projectId: string; accountId: string },
  turns: readonly EndedTurnForAnalytics[],
  status: 'idle' | 'error',
  errorName: string | undefined,
  abortErrorNames: readonly string[],
): Promise<void> {
  try {
    const [session] = await db
      .select({ createdBy: projectSessions.createdBy, initiatorType: projectSessions.initiatorType })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, owner.sessionId))
      .limit(1);
    if (!session?.createdBy || session.initiatorType !== 'member') return;
    const outcome =
      status === 'idle' ? 'ok' : errorName && abortErrorNames.includes(errorName) ? 'aborted' : 'error';
    const now = Date.now();
    for (const turn of turns) {
      captureProductEvent({
        userId: session.createdBy,
        accountId: owner.accountId,
        event: 'turn_completed',
        dedupeKey: turn.token,
        properties: {
          project_id: owner.projectId,
          session_id: owner.sessionId,
          status: outcome,
          end_reason: status === 'error' ? 'failed' : 'completed',
          duration_ms: turn.startedAtMs === null ? null : Math.max(0, now - turn.startedAtMs),
        },
      });
    }
  } catch {
    // Analytics never fails a turn end.
  }
}
