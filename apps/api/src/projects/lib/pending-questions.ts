/**
 * Park-and-restore for a blocked turn.
 *
 * THE PROBLEM. When the agent calls the `question` tool it stops and waits for
 * a human. A waiting turn makes no gateway LLM calls and the reaper renews
 * nothing for it, so after the wait bound (`turnWaitingMaxMs`) the turn ends
 * and its box is parked (box-reaper.ts `holdWaitingTurn`). That part is
 * correct and must stay correct: the whole bounded-lifetime design rests on "only a
 * control-plane-OBSERVED event may extend a box", and a box that could keep
 * itself alive by saying "I'm still waiting" is exactly the self-renewal that
 * once left 187 boxes running, the oldest for 264 hours.
 *
 * What was wrong is what parking DESTROYED. The runtime restarts cold, so its
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

import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { sessionPendingQuestions } from '@kortix/db';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export interface PendingQuestion {
  id: string;
  session_id: string;
  request_id: string;
  runtime_session_id: string | null;
  questions: RuntimeQuestion[];
  asked_at: string;
}

/**
 * Record a question the agent is blocked on.
 *
 * Returns the stored row. Idempotent: a replayed relay updates the payload in
 * place rather than inserting a second prompt. `inserted` is true only for the
 * first record of a (session_id, request_id) pair.
 */
export async function recordPendingQuestion(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  requestId: string;
  runtimeSessionId?: string | null;
  questions: RuntimeQuestion[];
  /** The runtime parks it when nobody answers live; it stays open past the turn (session-asks.ts). */
  parkable?: boolean;
  surfaceSessionId?: string | null;
  expiresAt?: string | null;
}): Promise<(PendingQuestion & { inserted: boolean }) | null> {
  const [row] = await db
    .insert(sessionPendingQuestions)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      runtimeSessionId: input.runtimeSessionId ?? null,
      questions: input.questions as never,
      parkable: input.parkable === true,
      surfaceSessionId: input.surfaceSessionId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [sessionPendingQuestions.sessionId, sessionPendingQuestions.requestId],
      set: {
        questions: input.questions as never,
        runtimeSessionId: input.runtimeSessionId ?? null,
        updatedAt: new Date().toISOString(),
      },
    })
    .returning({
      id: sessionPendingQuestions.id,
      sessionId: sessionPendingQuestions.sessionId,
      requestId: sessionPendingQuestions.requestId,
      runtimeSessionId: sessionPendingQuestions.runtimeSessionId,
      questions: sessionPendingQuestions.questions,
      askedAt: sessionPendingQuestions.askedAt,
      // PostgreSQL leaves xmax at 0 on a freshly inserted row version and sets
      // it on the ON CONFLICT DO UPDATE path, so this separates a first ask
      // from a replayed relay without a second query.
      inserted: sql<boolean>`(xmax = 0)`,
    });
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.sessionId,
    request_id: row.requestId,
    runtime_session_id: row.runtimeSessionId,
    // `jsonb`; only /turn-question writes it, after coercing to RuntimeQuestion[].
    questions: row.questions as RuntimeQuestion[],
    asked_at: row.askedAt,
    inserted: row.inserted === true,
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
      runtimeSessionId: sessionPendingQuestions.runtimeSessionId,
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
    runtime_session_id: row.runtimeSessionId,
    // `jsonb`; only /turn-question writes it, after coercing to RuntimeQuestion[].
    questions: row.questions as RuntimeQuestion[],
    asked_at: row.askedAt,
  };
}

/** A stored question by its row id, in its project: a chat button names it. */
export async function getPendingQuestion(
  projectId: string,
  id: string,
): Promise<{
  sessionId: string;
  requestId: string;
  questions: RuntimeQuestion[];
  answeredAt: string | null;
  answers: unknown;
  chatSteps: unknown;
} | null> {
  const [row] = await db
    .select({
      sessionId: sessionPendingQuestions.sessionId,
      requestId: sessionPendingQuestions.requestId,
      questions: sessionPendingQuestions.questions,
      answeredAt: sessionPendingQuestions.answeredAt,
      answers: sessionPendingQuestions.answers,
      chatSteps: sessionPendingQuestions.chatSteps,
    })
    .from(sessionPendingQuestions)
    .where(and(eq(sessionPendingQuestions.id, id), eq(sessionPendingQuestions.projectId, projectId)))
    .limit(1);
  return row ? { ...row, questions: row.questions as RuntimeQuestion[] } : null;
}

/** An open question by its row id, in its project (`POST /asks/:askId/answer`). */
export async function getPendingQuestionById(
  projectId: string,
  id: string,
): Promise<{ sessionId: string; surfaceSessionId: string | null; requestId: string; questions: RuntimeQuestion[] } | null> {
  const [row] = await db
    .select({
      sessionId: sessionPendingQuestions.sessionId,
      surfaceSessionId: sessionPendingQuestions.surfaceSessionId,
      requestId: sessionPendingQuestions.requestId,
      questions: sessionPendingQuestions.questions,
    })
    .from(sessionPendingQuestions)
    .where(and(eq(sessionPendingQuestions.id, id), eq(sessionPendingQuestions.projectId, projectId)))
    .limit(1);
  return row ? { ...row, questions: row.questions as RuntimeQuestion[] } : null;
}

/** A person dismissed the question: close it unanswered. False: it was already closed. */
export async function dismissPendingQuestion(sessionId: string, requestId: string): Promise<boolean> {
  return (await clearOpenQuestions(sessionId, { requestId })) > 0;
}

/**
 * Move a chat's answers so far (`chat_steps`) from `from`, the value read, to
 * `to`. False: another press moved them first, and nothing is written.
 */
export async function advancePendingQuestionSteps(projectId: string, id: string, from: unknown, to: unknown): Promise<boolean> {
  const rows = await db
    .update(sessionPendingQuestions)
    .set({ chatSteps: to as never, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(sessionPendingQuestions.id, id),
        eq(sessionPendingQuestions.projectId, projectId),
        sql`${sessionPendingQuestions.chatSteps} IS NOT DISTINCT FROM ${from == null ? null : JSON.stringify(from)}::jsonb`,
      ),
    )
    .returning({ id: sessionPendingQuestions.id });
  return rows.length > 0;
}

/** The session's stored question whose chat steps `by` wrote: a retried message finds its own answer. */
export async function pendingQuestionStepsBy(sessionId: string, by: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sessionPendingQuestions.id })
    .from(sessionPendingQuestions)
    .where(and(eq(sessionPendingQuestions.sessionId, sessionId), sql`${sessionPendingQuestions.chatSteps}->>'by' = ${by}`))
    .limit(1);
  return row?.id ?? null;
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
 * Close a session's open questions: nobody waits on them any more (KRTX-1739).
 * A stale question is worse than none: GET needs-input, the digest and the
 * session lists count it, and a resumed session would invite an answer nothing
 * waits for. The callers:
 *
 * - a turn end that closed the turn — idle, a stop, a failure
 *   (routes/turn-stream-handlers.ts). The reaper's `TurnAwaitingInput` end is
 *   not one: the box parks and the question waits for its answer;
 * - a prompt delivered into the session, for the questions asked before it was
 *   sent (`askedBefore`, session-lifecycle/queued-continue-delivery.ts);
 * - the runtime answered `requestId`: a person replied or dismissed it through
 *   the session proxy, or the server released a Slack/Teams question.
 *
 * A parkable question outlives the first two (`keepParked`): the runtime parked
 * it, and it closes only when a person answers or dismisses it, or it expires.
 */
export async function clearOpenQuestions(
  sessionId: string,
  scope: {
    requestId?: string;
    askedBefore?: Date;
    /**
     * Leave parkable questions open: the runtime parked them, and they wait
     * for a person past the turn end and past later prompts (session-asks.ts).
     * The turn end, a delivered prompt, and a runtime 404 pass it.
     */
    keepParked?: boolean;
  } = {},
): Promise<number> {
  const rows = await db
    .update(sessionPendingQuestions)
    .set({ answeredAt: sql`NOW()`, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(sessionPendingQuestions.sessionId, sessionId),
        isNull(sessionPendingQuestions.answeredAt),
        scope.requestId ? eq(sessionPendingQuestions.requestId, scope.requestId) : undefined,
        scope.askedBefore ? lt(sessionPendingQuestions.askedAt, scope.askedBefore.toISOString()) : undefined,
        scope.keepParked ? eq(sessionPendingQuestions.parkable, false) : undefined,
      ),
    )
    .returning({ id: sessionPendingQuestions.id });
  return rows.length;
}

/**
 * Render a stored question and its answer as the text of a follow-up turn.
 *
 * The answer CANNOT be delivered inline to the call that blocked. That call
 * lived in a runtime process which has since been parked and restarted cold —
 * its request id no longer exists, and nothing is waiting on it. This is also
 * how the channel path has always worked: "the user's in-thread reply arrives
 * as a follow-up turn" (routes/turn-questions.ts).
 *
 * So the answer arrives as a new turn, and it has to carry its own context: the
 * fresh runtime has no pending call. Quoting the question is what makes
 * the reply legible instead of a bare "yes" with nothing to attach it to.
 *
 * Several questions are paired by position: each answer under its own
 * question, so an answer to only some of them says which.
 */
export function renderAnswerPrompt(questions: unknown, answers: unknown): string {
  const asked = Array.isArray(questions) ? questions.map(questionText) : [];
  const given = Array.isArray(answers) ? answers.map(answerText) : [];
  if (asked.length > 1) {
    return `You asked:\n${asked.map((q, i) => [...(q ? [quote(q)] : []), given[i] ?? '(no answer given)'].join('\n')).join('\n\n')}`;
  }

  const lines: string[] = [];
  if (asked[0]) {
    lines.push('You asked:');
    lines.push(quote(asked[0]));
    lines.push('');
  }
  const said = given.filter((t): t is string => t !== null);
  lines.push(said.length > 0 ? said.join('\n') : '(no answer given)');
  return lines.join('\n');
}

/** Every line of a question quoted, so a reader (the agent, the transcript) sees where it ends. */
function quote(question: string): string {
  return question
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function questionText(q: unknown): string | null {
  const text =
    q && typeof q === 'object' ? ((q as { text?: unknown }).text ?? (q as { question?: unknown }).question) : q;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function answerText(a: unknown): string | null {
  const text = Array.isArray(a) ? a.join(', ') : typeof a === 'string' ? a : null;
  return text?.trim() ? text : null;
}
