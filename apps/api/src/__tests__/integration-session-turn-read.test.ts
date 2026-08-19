/**
 * Integration test (real local PostgreSQL): GET
 * /v1/projects/:projectId/sessions/:sessionId/turn against the real tables.
 *
 * The route test beside the handler mocks the database, so the handler's SQL
 * never executes there — a wrong column in a projection, a predicate Postgres
 * reads differently, or an ORDER BY that ties where the mock does not are all
 * invisible to it. This file drives the SAME Hono route with the REAL `db`, the
 * real `kortix.session_sandboxes` and `kortix.session_turns`, and asserts the
 * response body. Only authorization is mocked, because the question here is the
 * data, not the gate.
 *
 * What it pins is the reconciliation the endpoint exists for: liveness comes
 * from the LIFECYCLE AUTHORITY (`session_sandboxes.metadata.activeTurns`) and
 * history from the ledger, so a running turn with no ledger row is still
 * reported, and an open ledger row the authority no longer holds is not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import * as realDbModule from '../shared/db';
import * as realAccess from '../projects/lib/access';

const PROJECT_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = crypto.randomUUID();
const t = (name: string) => `${name}-${SANDBOX_ID}`;

mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: USER_ID,
  }),
  assertProjectCapability: async () => undefined,
  loadVisibleSession: async () => ({ row: { sessionId: SESSION_ID } }),
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/r8');

const app = new Hono<{ Variables: { userId: string; authType: string } }>();
app.use('*', async (c, next) => {
  c.set('userId', USER_ID);
  c.set('authType', 'pat');
  await next();
});
app.route('/v1/projects', projectsApp);

async function getTurn(): Promise<{
  turns: Array<Record<string, unknown>>;
  last_ended?: Record<string, unknown>;
}> {
  const response = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/turn`);
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

/** Write the box's lifecycle authority exactly as `beginSandboxTurn` and
 *  `initialSandboxTurnMetadata` write it. */
async function setAuthority(
  status: 'active' | 'provisioning' | 'stopped',
  turns: Array<{
    token: string;
    state: 'delivering' | 'active';
    opencodeSessionId?: string | null;
    messageId?: string | null;
    startedAtMs?: number;
  }>,
) {
  const activeTurns = Object.fromEntries(
    turns.map((turn) => [
      turn.token,
      {
        token: turn.token,
        state: turn.state,
        opencodeSessionId: turn.opencodeSessionId ?? null,
        messageId: turn.messageId ?? null,
        ...(turn.startedAtMs === undefined ? {} : { startedAtMs: turn.startedAtMs }),
      },
    ]),
  );
  await realDbModule.db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, metadata)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            ${status}::kortix.session_sandbox_status,
            ${JSON.stringify({ activeTurns })}::jsonb)
    ON CONFLICT (sandbox_id) DO UPDATE
       SET status = EXCLUDED.status,
           metadata = EXCLUDED.metadata`);
}

async function insertTurn(row: {
  token: string;
  state: 'delivering' | 'active' | 'ended';
  messageId?: string | null;
  opencodeSessionId?: string | null;
  startedAt: string;
  acceptedAt?: string | null;
  endReason?: string | null;
  endedAt?: string | null;
  error?: Record<string, unknown> | null;
}) {
  await realDbModule.db.execute(sql`
    INSERT INTO kortix.session_turns
      (turn_token, session_id, sandbox_id, project_id, account_id,
       opencode_session_id, message_id, state, end_reason, error, started_at,
       accepted_at, ended_at)
    VALUES (${row.token}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
            ${ACCOUNT_ID}::uuid, ${row.opencodeSessionId ?? null}, ${row.messageId ?? null},
            ${row.state}, ${row.endReason ?? null},
            ${row.error ? JSON.stringify(row.error) : null}::jsonb,
            ${row.startedAt}::timestamptz,
            ${row.acceptedAt ?? null}::timestamptz,
            ${row.endedAt ?? null}::timestamptz)`);
}

beforeEach(async () => {
  await realDbModule.db.execute(
    sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`,
  );
  await realDbModule.db.execute(
    sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`,
  );
  await realDbModule.db.execute(
    sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`,
  );
});

afterAll(async () => {
  await realDbModule.db
    .execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
  await realDbModule.db
    .execute(sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
  await realDbModule.db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
});

describe('GET .../turn against real Postgres', () => {
  test('a session with no box and no ledger row is idle and has no history', async () => {
    const body = await getTurn();
    expect(body.turns).toEqual([]);
    expect(Object.hasOwn(body, 'last_ended')).toBe(false);
  });

  test('reports a boot turn the ledger has never heard of', async () => {
    // `prepareInitialSandboxTurn` + `initialSandboxTurnMetadata` write the turn
    // into `activeTurns` and issue NO ledger INSERT; the first `session_turns`
    // row appears only when `acceptSandboxTurn` runs, after the daemon confirms
    // acceptance — 18.9s (daytona) / 24.5s (platinum) into a session start. A
    // ledger-only read answers "idle" for that entire window.
    await setAuthority('provisioning', [
      {
        token: t('boot'),
        state: 'delivering',
        messageId: 'msg_boot',
        startedAtMs: Date.parse('2026-08-17T00:00:00.000Z'),
      },
    ]);
    const result = await realDbModule.db.execute(
      sql`SELECT count(*)::int AS n FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`,
    );
    const counted = ((result as { rows?: Array<Record<string, unknown>> }).rows ?? result) as Array<
      Record<string, unknown>
    >;
    expect(counted[0].n).toBe(0);

    const body = await getTurn();
    expect(body.turns).toEqual([
      {
        turn_token: t('boot'),
        state: 'delivering',
        message_id: 'msg_boot',
        opencode_session_id: null,
        started_at: '2026-08-17T00:00:00.000Z',
        accepted_at: null,
      },
    ]);
  });

  test('decorates a live turn with accepted_at read from the right column', async () => {
    // The ledger row carries a different instant in every timestamp column, so
    // a projection that names the wrong one is visible in the body.
    await setAuthority('active', [
      {
        token: t('live'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_1',
        startedAtMs: Date.parse('2026-08-17T00:00:00.000Z'),
      },
    ]);
    await insertTurn({
      token: t('live'),
      state: 'active',
      opencodeSessionId: 'ses_root',
      messageId: 'msg_1',
      startedAt: '2026-08-17T00:00:00.500Z',
      acceptedAt: '2026-08-17T00:00:01.000Z',
      endedAt: '2026-08-17T09:09:09.000Z',
    });
    const body = await getTurn();
    expect(body.turns[0]).toEqual({
      turn_token: t('live'),
      state: 'active',
      message_id: 'msg_1',
      opencode_session_id: 'ses_root',
      started_at: '2026-08-17T00:00:00.000Z',
      accepted_at: '2026-08-17T00:00:01.000Z',
    });
  });

  test('never reports an open ledger row the authority no longer holds', async () => {
    // A swallowed settle on a box that keeps running leaves `state='active'`
    // for ever: `settleOrphanedSandboxTurns` closes a row only once its sandbox
    // has stopped, and the reaper reconciles from the authority, which no
    // longer names the token. Serving it as live is permanent phantom-busy.
    await setAuthority('active', []);
    await insertTurn({ token: t('stale'), state: 'active', startedAt: '2026-08-17T00:00:00.000Z' });
    await insertTurn({
      token: t('done'),
      state: 'ended',
      startedAt: '2026-08-17T00:00:02.000Z',
      endReason: 'completed',
      endedAt: '2026-08-17T00:00:09.000Z',
    });
    const body = await getTurn();
    expect(body.turns).toEqual([]);
    expect(body.last_ended).toEqual({
      turn_token: t('done'),
      message_id: null,
      end_reason: 'completed',
      ended_at: '2026-08-17T00:00:09.000Z',
      error: null,
    });
  });

  test('ignores the authority of a box that is no longer running', async () => {
    await setAuthority('stopped', [
      {
        token: t('orphan'),
        state: 'active',
        startedAtMs: Date.parse('2026-08-17T00:00:00.000Z'),
      },
    ]);
    const body = await getTurn();
    expect(body.turns).toEqual([]);
  });

  test('reports both concurrent turns, newest start first', async () => {
    await setAuthority('active', [
      {
        token: t('trigger'),
        state: 'active',
        messageId: 'msg_A',
        startedAtMs: Date.parse('2026-08-17T12:00:00.000Z'),
      },
      {
        token: t('web'),
        state: 'delivering',
        messageId: 'msg_B',
        startedAtMs: Date.parse('2026-08-17T12:00:02.000Z'),
      },
    ]);
    await insertTurn({
      token: t('trigger'),
      state: 'active',
      messageId: 'msg_A',
      startedAt: '2026-08-17T12:00:00.000Z',
      acceptedAt: '2026-08-17T12:00:00.400Z',
    });
    const body = await getTurn();
    expect(body.turns.map((turn) => turn.turn_token)).toEqual([t('web'), t('trigger')]);
    expect(body.turns.map((turn) => turn.message_id)).toEqual(['msg_B', 'msg_A']);
    expect(body.turns[1].accepted_at).toBe('2026-08-17T12:00:00.400Z');
    expect(body.turns[0].accepted_at).toBeNull();
  });

  test('last_ended is the NEWEST settled turn, by ended_at', async () => {
    // The two rows differ only in `ended_at`, so this is the ordering itself
    // and not a restatement of the ORDER BY line.
    await insertTurn({
      token: t('older'),
      state: 'ended',
      startedAt: '2026-08-17T00:00:00.000Z',
      endReason: 'completed',
      endedAt: '2026-08-17T00:00:03.000Z',
    });
    await insertTurn({
      token: t('newest'),
      state: 'ended',
      startedAt: '2026-08-17T00:00:00.000Z',
      endReason: 'runtime_gone',
      endedAt: '2026-08-17T00:00:09.000Z',
    });
    const body = await getTurn();
    expect(body.last_ended).toEqual({
      turn_token: t('newest'),
      message_id: null,
      end_reason: 'runtime_gone',
      ended_at: '2026-08-17T00:00:09.000Z',
      error: null,
    });
  });

  test('an unsettled ended row breaks the tie on started_at', async () => {
    // `ended_at` is nullable, so it cannot order the terminal read alone. In
    // Postgres a DESC sort puts NULLs FIRST, which is why both rows here carry
    // a null one — the second term is what decides.
    await insertTurn({
      token: t('first'),
      state: 'ended',
      startedAt: '2026-08-17T00:00:01.000Z',
      endedAt: null,
    });
    await insertTurn({
      token: t('second'),
      state: 'ended',
      startedAt: '2026-08-17T00:00:07.000Z',
      endedAt: null,
    });
    const body = await getTurn();
    expect(body.last_ended).toEqual({
      turn_token: t('second'),
      message_id: null,
      end_reason: null,
      ended_at: null,
      error: null,
    });
  });
});

/**
 * The failed-turn contract, end to end against real Postgres: a `jsonb` column
 * written by the finalizer, read back by the two routes a client polls.
 *
 * This is the failure a user meets as "I sent a message and nothing happened":
 * OpenCode raises `session.error` (a model id its provider map does not carry,
 * a provider 4xx, an exhausted balance) before any assistant message exists, so
 * it persists nothing for the turn but the user message. The transcript cannot
 * explain it; only this column can.
 */
describe('the terminal error against real Postgres', () => {
  const MODEL_NOT_FOUND = {
    name: 'ModelNotFound',
    message: 'Model kortix/grok-4.6 not found',
    status_code: 404,
    is_retryable: false,
    provider_id: 'kortix',
    recorded_at: '2026-08-17T00:00:09.000Z',
  };

  async function getTurns(query = ''): Promise<{ turns: Array<Record<string, unknown>> }> {
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/turns${query}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as never;
  }

  test('last_ended carries the error and the message it belongs to', async () => {
    await insertTurn({
      token: t('failed'),
      state: 'ended',
      messageId: 'msg_failed',
      startedAt: '2026-08-17T00:00:00.000Z',
      endReason: 'failed',
      endedAt: '2026-08-17T00:00:09.000Z',
      error: MODEL_NOT_FOUND,
    });
    const body = await getTurn();
    expect(body.last_ended).toEqual({
      turn_token: t('failed'),
      message_id: 'msg_failed',
      end_reason: 'failed',
      ended_at: '2026-08-17T00:00:09.000Z',
      error: MODEL_NOT_FOUND,
    });
  });

  test('the history read returns every turn, newest start first, with its error', async () => {
    // The point of the second route: after a reload the client holds a whole
    // transcript, and `last_ended` can only ever explain the newest failure.
    await insertTurn({
      token: t('h-old'),
      state: 'ended',
      messageId: 'msg_old',
      startedAt: '2026-08-17T00:00:01.000Z',
      endReason: 'failed',
      endedAt: '2026-08-17T00:00:02.000Z',
      error: MODEL_NOT_FOUND,
    });
    await insertTurn({
      token: t('h-new'),
      state: 'ended',
      messageId: 'msg_new',
      startedAt: '2026-08-17T00:00:08.000Z',
      endReason: 'completed',
      endedAt: '2026-08-17T00:00:09.000Z',
    });
    const body = await getTurns();
    expect(body.turns.map((turn) => turn.turn_token)).toEqual([t('h-new'), t('h-old')]);
    expect(body.turns[0].error).toBeNull();
    expect(body.turns[1]).toEqual({
      turn_token: t('h-old'),
      message_id: 'msg_old',
      opencode_session_id: null,
      state: 'ended',
      end_reason: 'failed',
      started_at: '2026-08-17T00:00:01.000Z',
      ended_at: '2026-08-17T00:00:02.000Z',
      error: MODEL_NOT_FOUND,
    });
  });

  test('the history read honours ?limit=', async () => {
    for (let i = 0; i < 3; i += 1) {
      await insertTurn({
        token: t(`h-limit-${i}`),
        state: 'ended',
        startedAt: `2026-08-17T00:00:0${i}.000Z`,
        endReason: 'completed',
      });
    }
    expect((await getTurns('?limit=2')).turns).toHaveLength(2);
    expect((await getTurns()).turns).toHaveLength(3);
  });

  // `session_lifecycle_commands` has FKs onto accounts, projects and
  // project_sessions — the inbox row cannot exist without them. Every other
  // test in this file writes only the two FK-free tables.
  beforeAll(async () => {
    await realDbModule.db.execute(sql`
      INSERT INTO kortix.accounts (account_id, name)
      VALUES (${ACCOUNT_ID}::uuid, 'turn-error-it') ON CONFLICT DO NOTHING`);
    await realDbModule.db.execute(sql`
      INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
      VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'turn-error-it',
              'https://example.invalid/r.git') ON CONFLICT DO NOTHING`);
    await realDbModule.db.execute(sql`
      INSERT INTO kortix.project_sessions
        (session_id, account_id, project_id, branch_name, status)
      VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
              ${`br-${SANDBOX_ID}`}, 'running') ON CONFLICT DO NOTHING`);
  });

  afterAll(async () => {
    for (const statement of [
      sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`,
      sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`,
      sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`,
      sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`,
    ]) {
      await realDbModule.db.execute(statement).catch(() => undefined);
    }
  });

  test('GET .../prompts joins the same error onto the queued row it belongs to', async () => {
    // The inbox and the ledger are two different tables and two different
    // failures: `last_error` is why the control plane could not DELIVER the
    // row, `error` is why the model run that carried it failed. Only real
    // Postgres proves the join predicate (session scope + wire id + a non-null
    // error) selects the right row.
    const wireId = 'msg_0198f3a1b2c4AbCdEfGhIjKlMn';
    await realDbModule.db.execute(sql`
      INSERT INTO kortix.session_lifecycle_commands
        (command_id, command_type, source, status, project_id, session_id, account_id, payload)
      VALUES (gen_random_uuid(), 'continue_session', 'ui', 'queued', ${PROJECT_ID}::uuid,
              ${SESSION_ID}, ${ACCOUNT_ID}::uuid,
              ${JSON.stringify({ text: 'hi', clientMessageId: 'c_1', wireMessageId: wireId })}::jsonb)`);
    await insertTurn({
      token: t('prompt-failed'),
      state: 'ended',
      messageId: wireId,
      startedAt: '2026-08-17T00:00:00.000Z',
      endReason: 'failed',
      endedAt: '2026-08-17T00:00:09.000Z',
      error: MODEL_NOT_FOUND,
    });

    const response = await app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/prompts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      prompts: Array<{ message_id: string; error: unknown; last_error: unknown }>;
    };
    expect(body.prompts).toHaveLength(1);
    expect(body.prompts[0].message_id).toBe(wireId);
    expect(body.prompts[0].error).toEqual(MODEL_NOT_FOUND);
    expect(body.prompts[0].last_error).toBeNull();
  });

  test('a jsonb round trip preserves every field, including the numbers', async () => {
    // `status_code` is a NUMBER in the column and must not come back as a
    // string: a client comparing it to 402 decides whether to show "out of
    // credits" or the generic failure.
    await insertTurn({
      token: t('json'),
      state: 'ended',
      startedAt: '2026-08-17T00:00:00.000Z',
      endReason: 'failed',
      endedAt: '2026-08-17T00:00:01.000Z',
      error: { ...MODEL_NOT_FOUND, status_code: 402, is_retryable: true },
    });
    const body = await getTurns();
    expect(body.turns[0].error).toEqual({
      ...MODEL_NOT_FOUND,
      status_code: 402,
      is_retryable: true,
    });
  });
});
