/**
 * Integration test (real local PostgreSQL): every turn end stamps the
 * session's `metadata.result_excerpt`, the answer a space shows under each
 * thread (`ThreadLatestReply` in packages/ui/src/workspace/spaces).
 *
 * Two writers close a turn. The daemon's `turn_end` relay (`settleTurnEnd`),
 * and the session-list read (`settleCompletedInboxTurns`), which closes a turn
 * the box reports over. A space timeline lists its threads while Kortix
 * answers, so the read often closes the turn ~20 ms before the relay arrives.
 * The relay then finds it `already_closed`. Before this fix only a relay that
 * closed the turn stamped the excerpt, so those threads showed no reply.
 * An API restart between the close and the detached excerpt write had the
 * same result: the daemon re-sends the end, and the re-send is `already_closed`.
 *
 * Real: the turn record and its ledger row, `settleTurnEnd`, the excerpt
 * write. Stubbed: the stored transcript (this suite has no box journal), the
 * forwarded reconcile and the notifier. `mock.module` is process-global: the
 * db-suites lane runs each file alone.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

const ANSWER = "You're in #general.";
const transcriptMessages: Array<{ role: string; text: string }> = [];

mock.module('../projects/session-lifecycle/forwarded-strand-reconcile', () => ({
  reconcileForwardedTurnsAtEnd: async () => undefined,
}));
const realPush = await import('../notifications/session-push');
mock.module('../notifications/session-push', () => ({ ...realPush, notifySessionEvent: async () => undefined }));
const realTranscript = await import('../projects/lib/session-transcript');
mock.module('../projects/lib/session-transcript', () => ({
  ...realTranscript,
  buildSessionTranscriptDigest: async () => ({ available: true, messages: [...transcriptMessages] }),
}));
// Collect the detached turn-end work, so each test awaits it instead of a clock.
// Copied before the mock: `mock.module` rewrites the live namespace.
const realDrain = { ...(await import('../shared/drain')) };
let detached: Promise<unknown>[] = [];
mock.module('../shared/drain', () => ({
  ...realDrain,
  trackDetached: (work: Promise<unknown>) => {
    detached.push(work);
    realDrain.trackDetached(work);
  },
}));

const { db } = await import('../shared/db');
const { settleTurnEnd } = await import('../projects/routes/turn-stream-handlers');
const { acceptSandboxTurn, beginSandboxTurn, clearSandboxTurn } = await import('../projects/sandbox-turn-lifecycle');
const { seedProject } = await import('./helpers/integration-fixtures');

type SeededProject = Awaited<ReturnType<typeof seedProject>>;

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

/** The daemon's `turn_end` relay for `messageId`, and the detached work it started. Returns the ledger outcome. */
async function endTurn(messageId: string): Promise<string> {
  const response = await settleTurnEnd(
    responder,
    { kind: 'turn_end', status: 'idle', runtime_session_id: RUNTIME_SESSION, turn_message_id: messageId },
    {
      projectId: project.project_id,
      sessionId,
      childSession: false,
      turnStreamMetadata: {},
      turnStreamSession: { accountId: project.account_id, createdBy: null, origin: 'user' },
    },
  );
  await Promise.all(detached);
  const body = (await response.json()) as { turn_completion: { outcome: string } };
  return body.turn_completion.outcome;
}

async function resultExcerpt(): Promise<unknown> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return (row?.metadata as Record<string, unknown> | null)?.result_excerpt ?? null;
}

beforeAll(async () => {
  project = await seedProject('turn-end-result-excerpt');
});

// No cleanup: the db-suites lane gives this file its own database and drops it,
// and a box row with an external id refuses deletion (guard_session_sandbox_identity).
beforeEach(async () => {
  detached = [];
  transcriptMessages.splice(0, transcriptMessages.length, { role: 'user', text: 'Where am I?' }, { role: 'assistant', text: ANSWER });
  await seedSessionWithBox();
});

describe('the turn end stamps the result excerpt', () => {
  test('the relay closes the turn: the excerpt is the answer', async () => {
    await startTurn('msg_closed');
    expect(await endTurn('msg_closed')).toBe('closed');
    expect(await resultExcerpt()).toBe(ANSWER);
  });

  test('the session-list read closed the turn first: the late relay still stamps the excerpt', async () => {
    const token = await startTurn('msg_read_first');
    // What `settleCompletedInboxTurns` does when the box reports the turn over.
    expect(await clearSandboxTurn(sandboxId, token, undefined, 'completed')).toBe(true);
    expect(await resultExcerpt()).toBeNull();
    expect(await endTurn('msg_read_first')).toBe('already_closed');
    expect(await resultExcerpt()).toBe(ANSWER);
  });

  test('a late relay of an old turn while a new turn runs writes nothing', async () => {
    const token = await startTurn('msg_old');
    expect(await clearSandboxTurn(sandboxId, token, undefined, 'completed')).toBe(true);
    await startTurn('msg_new');
    // The transcript tail is the new turn's: its answer is not the old turn's result.
    transcriptMessages.push({ role: 'user', text: 'And now?' }, { role: 'assistant', text: 'Working on it' });
    expect(await endTurn('msg_old')).toBe('already_closed');
    expect(await resultExcerpt()).toBeNull();
  });
});
