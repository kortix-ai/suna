/**
 * Integration test (real local PostgreSQL): a stored agent question closes
 * when nobody waits on it any more, and stays open while it can still be
 * answered (KRTX-1739).
 *
 * The stored question (`session_pending_questions`) is what GET needs-input,
 * the question digest and the session lists count. Before, nothing closed it
 * in practice: web and mobile answer through the runtime, and the turn end,
 * the next prompt and the Slack/Teams release left the row open. Every session
 * that ever asked a question counted as waiting on a person.
 *
 * It closes on:
 * - a turn end that closed the turn: idle, a stop, or a failure;
 * - a `continue_session` prompt delivered after the question was asked, when
 *   it starts a new turn;
 * - an answer the runtime took for that request id (the session proxy and the
 *   Slack/Teams release call `clearOpenQuestions` with it).
 * It stays open on:
 * - a retrying error (the turn has not ended);
 * - a direct follow-up (change-request feedback, an email, Slack or Teams
 *   reply) that joins the live turn: the runtime still blocks on the question;
 * - the reaper's `TurnAwaitingInput` end, and the daemon's late end frame for
 *   that turn: the box parks and the question waits for its answer.
 *
 * Real: the turn record and its ledger row, `settleTurnEnd`, the queue row and
 * its delivery bookkeeping. Stubbed: the box (transcript capture, forwarded
 * reconcile, `continueSession`) and the notifier, because this suite has none.
 * `mock.module` is process-global: the db-suites lane runs each file alone.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { sql } from 'drizzle-orm';

mock.module('../projects/lib/session-transcript-capture', () => ({
  captureJournallessSessionLog: async () => undefined,
}));
mock.module('../projects/session-lifecycle/forwarded-strand-reconcile', () => ({
  reconcileForwardedTurnsAtEnd: async () => undefined,
}));
const realPush = await import('../notifications/session-push');
mock.module('../notifications/session-push', () => ({ ...realPush, notifySessionEvent: async () => undefined }));
mock.module('../projects/session-lifecycle/continue-session', () => ({
  continueSession: async () => 'delivered',
}));

const { db } = await import('../shared/db');
const { clearOpenQuestions, recordPendingQuestion } = await import('../projects/lib/pending-questions');
const { settleTurnEnd } = await import('../projects/routes/turn-stream-handlers');
const { acceptSandboxTurn, beginSandboxTurn, clearSandboxTurn } = await import('../projects/sandbox-turn-lifecycle');
const { REAPER_TURN_CAUSES } = await import('../projects/session-turn-ledger');
const { buildContinueSessionCommandValues } = await import('../projects/session-lifecycle');
const { claimDueLifecycleCommands } = await import('../projects/session-lifecycle/command-claims');
const { deliverQueuedContinue } = await import('../projects/session-lifecycle/queued-continue-delivery');
const { ProvisionTimeline } = await import('../platform/services/provision-timeline');
const { seedProject } = await import('./helpers/integration-fixtures');

type SeededProject = Awaited<ReturnType<typeof seedProject>>;
type Rows = Array<Record<string, unknown>>;
const rowsOf = (result: unknown): Rows => ((result as { rows?: Rows }).rows ?? result) as Rows;

const RUNTIME_SESSION = 'ses_root';
let project: SeededProject;
let sessionId: string;
let sandboxId: string;

const responder = {
  json: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
};

/** A session with an active box. No creator: the turn end then skips the box read for its session list. */
async function seedSessionWithBox(): Promise<void> {
  sessionId = crypto.randomUUID();
  sandboxId = sessionId;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    status: 'running',
  });
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id)
    VALUES (${sandboxId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, 'active', ${`ext-${sandboxId}`})`);
}

/** The runtime accepted a prompt for `messageId`: the turn runs. */
async function startTurn(messageId: string): Promise<string> {
  const token = `tok-${messageId}`;
  const identity = { runtimeSessionId: RUNTIME_SESSION, messageId };
  await beginSandboxTurn({ sandboxId }, { token, ...identity });
  expect(await acceptSandboxTurn({ sandboxId }, token, identity)).toBe(true);
  return token;
}

/** The agent asked; `POST /turn-question` stored it. */
async function ask(requestId: string): Promise<void> {
  const stored = await recordPendingQuestion({
    accountId: project.account_id,
    projectId: project.project_id,
    sessionId,
    requestId,
    opencodeSessionId: RUNTIME_SESSION,
    questions: [{ question: 'Which region?', header: 'Region', options: [], multiple: false, custom: true }],
  });
  expect(stored?.inserted).toBe(true);
}

/** The daemon's `turn_end` relay for `messageId`. Returns the ledger outcome. */
async function endTurn(messageId: string, end: Record<string, unknown> = { status: 'idle' }): Promise<string> {
  const response = await settleTurnEnd(
    responder,
    { kind: 'turn_end', runtime_session_id: RUNTIME_SESSION, turn_message_id: messageId, ...end },
    {
      projectId: project.project_id,
      sessionId,
      childSession: false,
      turnStreamMetadata: {},
      turnStreamSession: { accountId: project.account_id, createdBy: null, origin: 'user' },
    },
  );
  const body = (await response.json()) as { turn_completion: { outcome: string } };
  return body.turn_completion.outcome;
}

/** The request ids of the session's open questions. */
async function openQuestions(): Promise<string[]> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT request_id FROM kortix.session_pending_questions
       WHERE session_id = ${sessionId} AND answered_at IS NULL
       ORDER BY request_id`),
  );
  return rows.map((row) => String(row.request_id));
}

beforeAll(async () => {
  project = await seedProject('pending-question-close');
});

// No cleanup: the db-suites lane gives this file its own database and drops it,
// and a box row with an external id refuses deletion (guard_session_sandbox_identity).
beforeEach(async () => {
  await seedSessionWithBox();
});

describe('a turn end that closes the turn closes its stored question', () => {
  test('the turn ends idle after the answer: the question closes', async () => {
    await startTurn('msg_idle');
    await ask('que_idle');
    expect(await endTurn('msg_idle')).toBe('closed');
    expect(await openQuestions()).toEqual([]);
  });

  test('the person stops the turn: the question closes', async () => {
    await startTurn('msg_stop');
    await ask('que_stop');
    expect(await endTurn('msg_stop', { status: 'error', error_name: 'MessageAbortedError' })).toBe('closed');
    expect(await openQuestions()).toEqual([]);
  });

  test('the turn fails: the question closes', async () => {
    await startTurn('msg_fail');
    await ask('que_fail');
    expect(
      await endTurn('msg_fail', { status: 'error', error_name: 'ProviderAuthError', error_retryable: false }),
    ).toBe('closed');
    expect(await openQuestions()).toEqual([]);
  });
});

describe('the question stays open while it can still be answered', () => {
  test('a retrying error has not ended the turn', async () => {
    await startTurn('msg_retry');
    await ask('que_retry');
    expect(await endTurn('msg_retry', { status: 'error', error_name: 'APIError', error_retryable: true })).toBe(
      'non_terminal',
    );
    expect(await openQuestions()).toEqual(['que_retry']);
  });

  test('the reaper ends the waiting turn as TurnAwaitingInput, and the late end frame of that turn keeps it', async () => {
    const token = await startTurn('msg_wait');
    await ask('que_wait');
    expect(await clearSandboxTurn(sandboxId, token, undefined, 'failed', REAPER_TURN_CAUSES.awaitingInput)).toBe(true);
    expect(await openQuestions()).toEqual(['que_wait']);
    // The box stops: the daemon reports the same turn aborted after the ledger closed it.
    expect(await endTurn('msg_wait', { status: 'error', error_name: 'MessageAbortedError' })).toBe('already_closed');
    expect(await openQuestions()).toEqual(['que_wait']);
  });
});

/** Deliver a `continue_session` row created 1 min ago, after `requestId` was asked (2 min ago). */
async function deliverPromptAfter(requestId: string, options: { directFollowUp?: boolean } = {}): Promise<void> {
  await db.execute(sql`
    UPDATE kortix.session_pending_questions SET asked_at = now() - interval '2 minutes'
     WHERE session_id = ${sessionId} AND request_id = ${requestId}`);
  const idempotencyKey = `prompt:${sessionId}:after-${requestId}`;
  await db.insert(sessionLifecycleCommands).values({
    ...buildContinueSessionCommandValues({
      source: 'ui',
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      actorUserId: null,
      text: 'Use eu-west-1.',
      idempotencyKey,
      ...(options.directFollowUp ? { directFollowUp: true } : {}),
    }),
    createdAt: new Date(Date.now() - 60_000),
  });
  const [row] = await claimDueLifecycleCommands({ workerId: 'question-close-it', limit: 1, idempotencyKey });
  expect(row).toBeDefined();
  const outcome = await deliverQueuedContinue(
    row!,
    row!.payload as never,
    'Use eu-west-1.',
    undefined,
    false,
    false,
    new ProvisionTimeline(row!.commandId, 'deliver'),
  );
  expect(outcome).toBe('succeeded');
}

describe('a delivered prompt supersedes the questions asked before it', () => {
  test('closes a question asked before the prompt was sent, not one asked after', async () => {
    await ask('que_before');
    // Asked now: after the prompt row was created (1 min ago).
    await ask('que_after');
    await deliverPromptAfter('que_before');
    expect(await openQuestions()).toEqual(['que_after']);
  });

  test('a direct follow-up to a session with no live turn starts a turn: the question closes', async () => {
    await ask('que_parked');
    await deliverPromptAfter('que_parked', { directFollowUp: true });
    expect(await openQuestions()).toEqual([]);
  });

  // Change-request feedback, an email, Slack or Teams reply skips admission
  // and joins the running turn. That turn still blocks on its question: the
  // runtime queues the prompt behind it. The turn end closes the question.
  test('a direct follow-up that joins the live turn keeps the question that turn blocks on', async () => {
    await startTurn('msg_blocked');
    await ask('que_blocked');
    await deliverPromptAfter('que_blocked', { directFollowUp: true });
    expect(await openQuestions()).toEqual(['que_blocked']);
    expect(await endTurn('msg_blocked')).toBe('closed');
    expect(await openQuestions()).toEqual([]);
  });
});

describe('an answer the runtime took closes only its own question', () => {
  test('the other open question keeps waiting', async () => {
    await ask('que_answered');
    await ask('que_other');
    expect(await clearOpenQuestions(sessionId, { requestId: 'que_answered' })).toBe(1);
    expect(await clearOpenQuestions(sessionId, { requestId: 'que_answered' })).toBe(0);
    expect(await openQuestions()).toEqual(['que_other']);
  });
});
