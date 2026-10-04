/**
 * Integration test (real local PostgreSQL): a turn writer racing a stop.
 *
 * `beginSandboxTurn` and `acceptSandboxTurn` write lifecycle authority and
 * their ledger row. A stop erases `activeTurns` and settles the sandbox's open
 * ledger rows in one transaction. A ledger row created AFTER that transaction
 * commits is open for ever on a box that is parked: every token-scoped settle
 * CASes on the `activeTurns` entry the stop deleted, and the stop's own
 * sandbox-scoped settle has already run. That is the permanent phantom-busy
 * state this table exists to end.
 *
 * The two writes were two round trips, and a stop could commit between them.
 * They are now ONE statement: the ledger row is written from the rows the
 * authority write itself returned. These tests run the SHIPPED functions
 * against a REAL stop in both orders and concurrently.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realDbModule from '../lib/db';

import {
  type SeededProject,
  removeSeeded,
  seedProject,
} from './helpers/integration-fixtures';

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `turn-stop-race-${SANDBOX_ID}`;
let ACCOUNT_ID: string;
let PROJECT_ID: string;
let project: SeededProject;
beforeAll(async () => {
  project = await seedProject('turn-stop-race');
  ACCOUNT_ID = project.account_id;
  PROJECT_ID = project.project_id;
  await realDbModule.db.execute(sql`INSERT INTO kortix.project_sessions
    (session_id, account_id, project_id, branch_name, agent_name, status)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${SESSION_ID}, 'default', 'running')`);
});
const t = (name: string) => `${name}-${SANDBOX_ID}`;

const {
  acceptSandboxTurn,
  beginSandboxTurn,
} = await import('../projects/sandbox-turn-lifecycle');
const {
  settleOpenSandboxTurns,
  settleOrphanedSandboxTurns,
  settleOrphanedSandboxTurnsQuery,
} = await import('../projects/session-turn-ledger');
const { applyStoppedState } = await import('../projects/reaping/sandbox-state-sync');

const rows = (result: unknown) =>
  ((result as { rows?: Array<Record<string, unknown>> }).rows ?? result) as Array<
    Record<string, unknown>
  >;

const stopTheBox = () =>
  applyStoppedState({
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    externalId: null,
    stopReason: 'deadline_expired',
  });

async function readTurn(token: string): Promise<Record<string, unknown> | undefined> {
  return rows(
    await realDbModule.db.execute(sql`
      SELECT state, end_reason FROM kortix.session_turns WHERE turn_token = ${token}`),
  )[0];
}

async function openRows(): Promise<number> {
  const [row] = rows(
    await realDbModule.db.execute(sql`
      SELECT count(*)::int AS open
        FROM kortix.session_turns
       WHERE sandbox_id = ${SANDBOX_ID}::uuid
         AND state <> 'ended'`),
  );
  return row.open as number;
}

beforeEach(async () => {
  await realDbModule.db.execute(sql`UPDATE kortix.project_sessions SET status = 'running', error = NULL WHERE session_id = ${SESSION_ID}`);
  await realDbModule.db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, metadata)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            'active', '{}'::jsonb)
    ON CONFLICT (sandbox_id) DO UPDATE
       SET status = 'active',
           metadata = '{}'::jsonb,
           deadline_at = now() + interval '10 minutes'`);
  await realDbModule.db.execute(
    sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`,
  );
});

afterAll(async () => {
  await realDbModule.db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
  await realDbModule.db
    .execute(sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
  await realDbModule.db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`);
  await removeSeeded([project]);
});

describe('a turn writer racing a stop', () => {
  async function seedBootTurn(token: string) {
    // A boot turn goes straight into metadata (initialSandboxTurnMetadata) and
    // never passes through beginSandboxTurn, so acceptance is its FIRST ledger
    // write: an INSERT of a row in state 'active'.
    await realDbModule.db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET metadata = jsonb_build_object('activeTurns', jsonb_build_object(
               ${token}::text, jsonb_build_object(
                 'token', ${token}::text,
                 'state', 'delivering',
                 'opencodeSessionId', 'ses_root',
                 'messageId', 'msg_race_boot',
                 'startedAtMs', 1)))
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  }

  test('beginSandboxTurn after a stop grants nothing and writes no ledger row', async () => {
    await stopTheBox();

    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('race-begin'), runtimeSessionId: 'ses_root', messageId: 'msg_race_begin' },
        60_000,
      ),
    ).toBe('no_box');

    expect(await readTurn(t('race-begin'))).toBeUndefined();
    expect(await openRows()).toBe(0);
  });

  test('acceptSandboxTurn after a stop accepts nothing and writes no ledger row for a boot turn', async () => {
    await seedBootTurn(t('race-boot'));
    await stopTheBox();

    expect(
      await acceptSandboxTurn({ sandboxId: SANDBOX_ID }, t('race-boot'), {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_race_boot',
      }),
    ).toBe(false);

    expect(await readTurn(t('race-boot'))).toBeUndefined();
    expect(await openRows()).toBe(0);
  });

  test('a boot turn accepted before the stop is settled by it', async () => {
    await seedBootTurn(t('race-boot-first'));
    expect(
      await acceptSandboxTurn({ sandboxId: SANDBOX_ID }, t('race-boot-first'), {
        runtimeSessionId: 'ses_root',
        messageId: 'msg_race_boot',
      }),
    ).toBe(true);
    expect(await readTurn(t('race-boot-first'))).toMatchObject({ state: 'active' });

    await stopTheBox();

    expect(await readTurn(t('race-boot-first'))).toMatchObject({ state: 'ended', end_reason: 'runtime_gone' });
    expect(await openRows()).toBe(0);
  });

  test('a begin and a stop issued together never leave an open ledger row', async () => {
    // Either order is legal. Both end with no open row: the begin lands first
    // and the stop settles its row, or the stop lands first and the begin
    // matches no box. The old two-round-trip writer could lose this race.
    for (let round = 0; round < 12; round += 1) {
      await realDbModule.db.execute(sql`
        UPDATE kortix.session_sandboxes
           SET status = 'active', metadata = '{}'::jsonb, deadline_at = now() + interval '10 minutes'
         WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
      const token = t(`race-concurrent-${round}`);
      const [begun] = await Promise.all([
        beginSandboxTurn(
          { sandboxId: SANDBOX_ID },
          { token, runtimeSessionId: 'ses_root', messageId: `msg_race_${round}` },
          60_000,
        ),
        stopTheBox(),
      ]);

      const turn = await readTurn(token);
      if (begun === 'granted') expect(turn).toMatchObject({ state: 'ended', end_reason: 'runtime_gone' });
      else expect(turn).toBeUndefined();
      expect(await openRows()).toBe(0);
    }
  });

  test('a turn whose ledger row already exists is settled by the stop, not lost', async () => {
    // The ordinary ordering, as the control: the grant and its row land, then
    // the stop settles the row it can see.
    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('race-settled'), runtimeSessionId: 'ses_root', messageId: 'msg_race_settled' },
        60_000,
      ),
    ).toBe('granted');
    expect(await readTurn(t('race-settled'))).toMatchObject({ state: 'delivering' });
    // A row that already ended keeps the reason it ended with.
    await realDbModule.db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id, state, end_reason, ended_at)
      VALUES (${t('race-done')}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
              ${ACCOUNT_ID}::uuid, 'ended', 'completed', now())`);

    await stopTheBox();

    expect(await readTurn(t('race-settled'))).toMatchObject({
      state: 'ended',
      end_reason: 'runtime_gone',
    });
    expect(await readTurn(t('race-done'))).toMatchObject({
      state: 'ended',
      end_reason: 'completed',
    });
    expect(await openRows()).toBe(0);
  });
});

describe('a ledger settle that fails inside a stop transaction', () => {
  test('rolls back to its savepoint and leaves the rest of the transaction committable', async () => {
    // A REAL statement error inside the stop's transaction, produced by the
    // table's own end_reason CHECK. Without the savepoint Postgres marks the
    // whole transaction aborted (25P02) and the stop's two status flips — which
    // run against a provider box that is ALREADY off — are lost with it.
    const error = console.error;
    console.error = () => {};
    try {
      await realDbModule.db.transaction(async (tx) => {
        await settleOpenSandboxTurns(tx as never, SANDBOX_ID, 'not-a-reason' as never);
        // The statement a stop still has to make after the failed settle.
        await tx.execute(sql`
          UPDATE kortix.session_sandboxes
             SET status = 'stopped', updated_at = now()
           WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
      });
    } finally {
      console.error = error;
    }

    const [row] = rows(
      await realDbModule.db.execute(sql`
        SELECT status FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`),
    );
    expect(row.status).toBe('stopped');
  });
});

describe('the reaper backstop', () => {
  /** Write a ledger row directly — the state a rolled-back settle leaves behind. */
  async function seedOpenRow(token: string, state: 'delivering' | 'active') {
    await realDbModule.db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id, state)
      VALUES (${token}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
              ${ACCOUNT_ID}::uuid, ${state})`);
  }

  test('settles an open row whose sandbox is parked, and leaves a running box alone', async () => {
    await seedOpenRow(t('orphan-parked'), 'active');
    await seedOpenRow(t('orphan-live'), 'delivering');

    // The box is still running: its turns are none of this pass's business.
    // The database is this file's own, so no other row can be counted.
    expect(await settleOrphanedSandboxTurns()).toBe(0);
    expect(await readTurn(t('orphan-parked'))).toMatchObject({ state: 'active' });
    expect(await readTurn(t('orphan-live'))).toMatchObject({ state: 'delivering' });

    await realDbModule.db.execute(sql`
      UPDATE kortix.session_sandboxes SET status = 'stopped'
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    expect(await settleOrphanedSandboxTurns()).toBe(2);
    expect(await readTurn(t('orphan-parked'))).toMatchObject({
      state: 'ended',
      end_reason: 'runtime_gone',
    });
    expect(await readTurn(t('orphan-live'))).toMatchObject({ state: 'ended' });
    expect(await openRows()).toBe(0);
  });

  test('settles an open row whose sandbox row is gone entirely', async () => {
    await seedOpenRow(t('orphan-deleted'), 'active');
    await realDbModule.db.execute(sql`
      DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    await settleOrphanedSandboxTurns();

    expect(await readTurn(t('orphan-deleted'))).toMatchObject({
      state: 'ended',
      end_reason: 'runtime_gone',
    });
  });

  test('never rewrites a reason a row already carries', async () => {
    // A settle that lost its savepoint may have stamped the row before the
    // rollback, and a history this pass rewrote would be worse than none.
    await realDbModule.db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id, state, end_reason)
      VALUES (${t('orphan-reasoned')}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
              ${ACCOUNT_ID}::uuid, 'active', 'failed')`);
    await realDbModule.db.execute(sql`
      UPDATE kortix.session_sandboxes SET status = 'stopped'
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    await settleOrphanedSandboxTurns();

    expect(await readTurn(t('orphan-reasoned'))).toMatchObject({
      state: 'ended',
      end_reason: 'failed',
    });
  });

  test('session_turns_open_idx serves the backstop predicate', async () => {
    // Terminal rows are retained for ever, so a pass that runs on every reaper
    // tick must scan what is still OPEN, not the whole history. On a near-empty
    // table a seq scan is the correct plan, so this asserts the partial index is
    // USABLE for the SHIPPED statement — a predicate it cannot serve stays a
    // seq scan even here.
    const plan = await realDbModule.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return rows(await tx.execute(sql`EXPLAIN ${settleOrphanedSandboxTurnsQuery()}`))
        .map((row) => String(Object.values(row)[0]))
        .join('\n');
    });

    expect(plan).toContain('session_turns_open_idx');
  });
});
