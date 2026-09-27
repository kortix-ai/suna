/**
 * Integration test (real local PostgreSQL): the turn-end strand repair's
 * durable half, `requeueStranded`, reached through the production entry point
 * `reconcileForwardedTurnsAtEnd` and its real default dependencies.
 *
 * The unit suite beside the module (`forwarded-strand-reconcile.test.ts`)
 * injects every dependency, so the re-queue statement never runs there. Its
 * 2026-08-20 regression lived in exactly that statement: it matched the
 * payload ids only, so a stranded prompt delivered under an id that only
 * `result.forwarded_message_id` recorded returned `no_row` and was never
 * redelivered. `integration-prompt-inbox` proves the other readers of the
 * shared `wireMessageIdMatches` predicate; this file proves this one.
 *
 * Stubbed: the box. `sandboxOpencodeEndpoint` returns a fixed address, `fetch`
 * serves the transcript tip and accepts the message delete, and the drain kick
 * is recorded instead of delivering. The ledger read, the command-row lookup
 * and the re-queue write run against real rows.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realOpencodeMapping from '../projects/opencode-mapping';
import * as realDrain from '../projects/session-lifecycle/drain';
import { WIRE_ID_TIME_SCALE } from '../projects/wire-message-id';

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const SESSION_ID = crypto.randomUUID();
const SANDBOX_ID = crypto.randomUUID();
const OPENCODE_SESSION = 'ses_strand_root';
const BOX_URL = 'http://strand-box.test';
const BOX_ORIGIN = new URL(BOX_URL).origin;

const T = 1_800_000_000_000;
const wireId = (ms: number, tail: string) =>
  `msg_${((BigInt(ms) * WIRE_ID_TIME_SCALE + BigInt(1)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0')}${tail}`;
/** The user message the step that ended answered. */
const ANSWERED = wireId(T, 'USERMUSERMUSER');
/** Forwarded into the live turn, persisted below an assistant that predates it. */
const STRANDED = wireId(T + 500, 'STRANDSTRANDST');
const ASSISTANT = wireId(T + 1_000, 'ASSTMASSTMASST');
/** The id the client minted. The delivery went out under STRANDED instead. */
const CLIENT_WIRE_ID = wireId(T - 5_000, 'CLIENTCLIENTCL');

let deletedMessages: string[] = [];
let drainKicks: Array<Record<string, unknown>> = [];

mock.module('../projects/opencode-mapping', () => ({
  ...realOpencodeMapping,
  sandboxOpencodeEndpoint: async () => ({ url: BOX_URL, headers: {} }),
}));
mock.module('../projects/session-lifecycle/drain', () => ({
  ...realDrain,
  drainSessionLifecycleQueue: (input: Record<string, unknown>) => {
    drainKicks.push(input);
    return Promise.resolve();
  },
}));

const { db } = await import('../shared/db');
const { reconcileForwardedTurnsAtEnd } = await import(
  '../projects/session-lifecycle/forwarded-strand-reconcile'
);
const { enqueueContinueSessionCommand, markCommandForwarded } = await import(
  '../projects/session-lifecycle/store'
);

/** OpenCode's `GET /session/:id/message` body: ANSWERED, then STRANDED below
 *  the assistant that answered ANSWERED. Nothing is parented on STRANDED. */
const TIP = [
  { info: { id: ANSWERED, role: 'user', time: { created: T } }, parts: [{ id: 'prt_a' }] },
  { info: { id: STRANDED, role: 'user', time: { created: T + 500 } }, parts: [{ id: 'prt_s' }] },
  {
    info: {
      id: ASSISTANT,
      role: 'assistant',
      parentID: ANSWERED,
      time: { created: T + 1_000, completed: T + 1_500 },
    },
    parts: [{ id: 'prt_r' }],
  },
];

const ORIGINAL_FETCH = globalThis.fetch;

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? result) as T[];
}

/** One forwarded inbox prompt: payload id CLIENT_WIRE_ID, sent as STRANDED. */
async function forwardedPrompt(payloadPatch: Record<string, unknown> = {}): Promise<string> {
  const { row } = await enqueueContinueSessionCommand({
    source: 'ui',
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: null,
    text: 'second thought',
    idempotencyKey: `prompt:${SESSION_ID}:${crypto.randomUUID()}`,
    clientMessageId: `q_${crypto.randomUUID()}`,
    wireMessageId: CLIENT_WIRE_ID,
    parts: [{ type: 'text', text: 'second thought' }],
  });
  await db.execute(sql`
    UPDATE kortix.session_lifecycle_commands
       SET status = 'running', locked_by = 'strand-it',
           payload = payload || ${JSON.stringify(payloadPatch)}::jsonb
     WHERE command_id = ${row.commandId}::uuid`);
  await markCommandForwarded(
    { commandId: row.commandId, lockedBy: 'strand-it' },
    SESSION_ID,
    STRANDED,
  );
  // The ledger row the forward opened, still open at turn end.
  await db.execute(sql`
    INSERT INTO kortix.session_turns
      (turn_token, session_id, sandbox_id, project_id, account_id, opencode_session_id, message_id, state)
    VALUES (${`tok-${row.commandId}`}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
            ${ACCOUNT_ID}::uuid, ${OPENCODE_SESSION}, ${STRANDED}, 'active')`);
  return row.commandId;
}

async function readCommand(commandId: string) {
  const [row] = rowsOf<{
    status: string;
    payload: Record<string, unknown>;
    result: Record<string, unknown>;
  }>(
    await db.execute(sql`
      SELECT status, payload, result FROM kortix.session_lifecycle_commands
       WHERE command_id = ${commandId}::uuid`),
  );
  return row;
}

function reconcile() {
  return reconcileForwardedTurnsAtEnd({
    sessionId: SESSION_ID,
    opencodeSessionId: OPENCODE_SESSION,
    endedMessageId: ANSWERED,
  });
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'strand-reconcile-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'strand-reconcile-it', 'https://example.invalid/r.git')`);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions
      (session_id, account_id, project_id, branch_name, status, opencode_session_id)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${SESSION_ID}`}, 'running',
            ${OPENCODE_SESSION})`);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, status)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            ${`ext-${SANDBOX_ID}`}, 'active')`);
  (globalThis as { fetch: unknown }).fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    // Compare the parsed origin, not a string prefix: `startsWith(BOX_URL)`
    // also matches an attacker-controlled host such as
    // `http://strand-box.test.evil.example` (CodeQL: incomplete URL substring
    // sanitization). A URL that fails to parse is never the box either.
    let origin: string | null;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = null;
    }
    if (origin !== BOX_ORIGIN) return ORIGINAL_FETCH(input, init);
    if ((init?.method ?? 'GET') === 'DELETE') {
      deletedMessages.push(decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''));
      return new Response(null, { status: 200 });
    }
    return Response.json(TIP);
  };
});

beforeEach(async () => {
  deletedMessages = [];
  drainKicks = [];
  await db.execute(sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`);
  await db.execute(
    sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`,
  );
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  mock.restore();
});

test('a stranded prompt known only by its forwarded id is taken out of the transcript and re-queued', async () => {
  const commandId = await forwardedPrompt();

  const out = await reconcile();

  expect(out).toMatchObject({ candidates: 1, stranded: 1, requeued: 1 });
  expect(deletedMessages).toEqual([STRANDED]);
  const row = await readCommand(commandId);
  expect(row.status).toBe('queued');
  expect(row.payload).toMatchObject({ redeliveries: 1, remintOnDelivery: true });
  expect(row.result).toEqual({ redelivered_from: 'stranded_placement' });
  expect(drainKicks).toHaveLength(1);
});

test('a prompt already redelivered three times is not re-queued again', async () => {
  const commandId = await forwardedPrompt({ redeliveries: 3 });

  const out = await reconcile();

  expect(out).toMatchObject({ stranded: 1, requeued: 0 });
  const row = await readCommand(commandId);
  expect(row.status).toBe('succeeded');
  expect(row.result).toMatchObject({ forwarded_message_id: STRANDED });
  expect(drainKicks).toEqual([]);
});
