/**
 * Park-and-restore for a blocked turn.
 *
 * THE PROBLEM. When the agent calls the `question` tool it stops and waits for
 * a human. A waiting turn makes no gateway LLM calls, so it earns no deadline
 * extension, so its box is parked on schedule. That part is correct and must
 * stay correct: the whole bounded-lifetime design rests on "only a
 * control-plane-OBSERVED event may extend a box", and a box that could keep
 * itself alive by saying "I'm still waiting" is exactly the self-renewal that
 * once left 187 boxes running, the oldest for 264 hours.
 *
 * What was wrong is what parking DESTROYED. opencode restarts cold, so its
 * in-memory pending question died with the box and the user came back to a
 * session that had silently forgotten what it asked. The turn was lost, not
 * paused.
 *
 * THE FIX is to separate the two. Let the box die on time; keep the question
 * out here, where it survives. Recording a question therefore does NOT touch
 * the deadline — deliberately, and the tests assert it.
 *
 * The relay is best-effort and retries, so recording is an upsert keyed on
 * (session_id, request_id): the same question arriving twice must not become
 * two prompts in the UI.
 *
 * The restore half — `GET`/`POST /v1/projects/:projectId/sessions/:sessionId/question`
 * (read the open row; answer it as a follow-up turn) — was removed from
 * routes/r4.ts together with `getOpenQuestion`, `resolvePendingQuestion`,
 * `renderAnswerPrompt` and `clearOpenQuestions`.
 *
 * WHAT IS TRUE NOW, stated plainly so nobody reads a dead path as live: the row
 * is WRITTEN by POST /turn-question (the ask survives the box), and NOTHING in
 * the API sets `answered_at` — no route answers it and no turn-end hook closes
 * it. The one consumer is the ops classifier
 * (apps/api/scripts/classify-stop-paths.sql), which reads "does this session
 * hold an open question" via the partial index on `answered_at IS NULL` to
 * explain why a box parked. That is a diagnostic read, not a product path. If a
 * restore path is rebuilt, it owns closing the row; until then rows stay open.
 */

import { sessionPendingQuestions } from '@kortix/db';
import { db } from '../../shared/db';

export interface PendingQuestion {
  id: string;
  session_id: string;
  request_id: string;
  opencode_session_id: string | null;
  questions: unknown;
  asked_at: string;
}

/**
 * Record a question the agent is blocked on.
 *
 * Returns the stored row. Idempotent: a replayed relay updates the payload in
 * place rather than inserting a second prompt.
 */
export async function recordPendingQuestion(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  requestId: string;
  opencodeSessionId?: string | null;
  questions: unknown;
}): Promise<PendingQuestion | null> {
  const [row] = await db
    .insert(sessionPendingQuestions)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      opencodeSessionId: input.opencodeSessionId ?? null,
      questions: input.questions as never,
    })
    .onConflictDoUpdate({
      target: [sessionPendingQuestions.sessionId, sessionPendingQuestions.requestId],
      set: {
        questions: input.questions as never,
        opencodeSessionId: input.opencodeSessionId ?? null,
        updatedAt: new Date().toISOString(),
      },
    })
    .returning({
      id: sessionPendingQuestions.id,
      sessionId: sessionPendingQuestions.sessionId,
      requestId: sessionPendingQuestions.requestId,
      opencodeSessionId: sessionPendingQuestions.opencodeSessionId,
      questions: sessionPendingQuestions.questions,
      askedAt: sessionPendingQuestions.askedAt,
    });
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.sessionId,
    request_id: row.requestId,
    opencode_session_id: row.opencodeSessionId,
    questions: row.questions,
    asked_at: row.askedAt,
  };
}
