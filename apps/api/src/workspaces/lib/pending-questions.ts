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
 */

import { sessionPendingQuestions } from '@kortix/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
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
  workspaceId: string;
  sessionId: string;
  requestId: string;
  opencodeSessionId?: string | null;
  questions: unknown;
}): Promise<PendingQuestion | null> {
  const [row] = await db
    .insert(sessionPendingQuestions)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
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

/**
 * The question this session is currently blocked on, if any.
 *
 * Newest first: a session should only ever have one open question, but if a
 * relay raced a restart the most recent ask is the live one.
 */
export async function getOpenQuestion(sessionId: string): Promise<PendingQuestion | null> {
  const [row] = await db
    .select({
      id: sessionPendingQuestions.id,
      sessionId: sessionPendingQuestions.sessionId,
      requestId: sessionPendingQuestions.requestId,
      opencodeSessionId: sessionPendingQuestions.opencodeSessionId,
      questions: sessionPendingQuestions.questions,
      askedAt: sessionPendingQuestions.askedAt,
    })
    .from(sessionPendingQuestions)
    .where(
      and(
        eq(sessionPendingQuestions.sessionId, sessionId),
        isNull(sessionPendingQuestions.answeredAt),
      ),
    )
    .orderBy(desc(sessionPendingQuestions.askedAt))
    .limit(1);
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

/**
 * Mark a question answered.
 *
 * Conditional on it still being open, so a late duplicate answer cannot
 * overwrite the first one's payload — same compare-and-set discipline the
 * compute settle uses. Returns false when somebody already answered it.
 */
export async function resolvePendingQuestion(input: {
  sessionId: string;
  requestId: string;
  answers: unknown;
}): Promise<boolean> {
  const rows = await db
    .update(sessionPendingQuestions)
    .set({
      answeredAt: sql`NOW()`,
      answers: input.answers as never,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(sessionPendingQuestions.sessionId, input.sessionId),
        eq(sessionPendingQuestions.requestId, input.requestId),
        isNull(sessionPendingQuestions.answeredAt),
      ),
    )
    .returning({ id: sessionPendingQuestions.id });
  return rows.length > 0;
}

/**
 * Drop a session's open questions.
 *
 * Called when a turn ends for any other reason — the agent gave up, errored, or
 * the user sent a new prompt that supersedes the ask. A stale prompt rendered
 * on resume is worse than none: it invites an answer nothing is waiting for.
 */
export async function clearOpenQuestions(sessionId: string): Promise<number> {
  const rows = await db
    .update(sessionPendingQuestions)
    .set({ answeredAt: sql`NOW()`, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(sessionPendingQuestions.sessionId, sessionId),
        isNull(sessionPendingQuestions.answeredAt),
      ),
    )
    .returning({ id: sessionPendingQuestions.id });
  return rows.length;
}

/**
 * Render a stored question and its answer as the text of a follow-up turn.
 *
 * The answer CANNOT be delivered inline to the call that blocked. That call
 * lived in an opencode process which has since been parked and restarted cold —
 * its request id no longer exists, and nothing is waiting on it. This is also
 * how the channel path has always worked: "the user's in-thread reply arrives
 * as a follow-up turn" (routes/r4.ts).
 *
 * So the answer arrives as a new turn, and it has to carry its own context: the
 * fresh opencode has no memory of asking. Quoting the question is what makes
 * the reply legible instead of a bare "yes" with nothing to attach it to.
 */
export function renderAnswerPrompt(questions: unknown, answers: unknown): string {
  const asked = Array.isArray(questions)
    ? questions
        .map((q) => {
          const text =
            q && typeof q === 'object'
              ? ((q as { text?: unknown; question?: unknown }).text ??
                (q as { question?: unknown }).question)
              : q;
          return typeof text === 'string' ? text.trim() : null;
        })
        .filter((t): t is string => !!t)
    : [];

  const given = Array.isArray(answers)
    ? answers
        .map((a) => (Array.isArray(a) ? a.join(', ') : typeof a === 'string' ? a : null))
        .filter((t): t is string => !!t && t.trim().length > 0)
    : [];

  const lines: string[] = [];
  if (asked.length > 0) {
    lines.push('You asked:');
    for (const q of asked) lines.push(`> ${q}`);
    lines.push('');
  }
  lines.push(given.length > 0 ? given.join('\n') : '(no answer given)');
  return lines.join('\n');
}
