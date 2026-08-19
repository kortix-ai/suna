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
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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
}) {
  await realDbModule.db.execute(sql`
    INSERT INTO kortix.session_turns
      (turn_token, session_id, sandbox_id, project_id, account_id,
       opencode_session_id, message_id, state, end_reason, started_at, accepted_at, ended_at)
    VALUES (${row.token}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
            ${ACCOUNT_ID}::uuid, ${row.opencodeSessionId ?? null}, ${row.messageId ?? null},
            ${row.state}, ${row.endReason ?? null},
            ${row.startedAt}::timestamptz,
            ${row.acceptedAt ?? null}::timestamptz,
            ${row.endedAt ?? null}::timestamptz)`);
}

beforeEach(async () => {
  await realDbModule.db.execute(
    sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`,
  );
  await realDbModule.db.execute(
    sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`,
  );
});

afterAll(async () => {
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
      end_reason: 'completed',
      ended_at: '2026-08-17T00:00:09.000Z',
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
      end_reason: 'runtime_gone',
      ended_at: '2026-08-17T00:00:09.000Z',
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
      end_reason: null,
      ended_at: null,
    });
  });
});
