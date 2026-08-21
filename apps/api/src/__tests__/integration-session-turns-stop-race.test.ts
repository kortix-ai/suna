/**
 * Integration test (real local PostgreSQL): the gap between a turn writer's TWO
 * database round trips, and the stop that can commit inside it.
 *
 * `beginSandboxTurn` and `acceptSandboxTurn` write lifecycle authority first and
 * their ledger row second. A stop landing between those two statements erases
 * the authority the ledger row would be settled against — every token-scoped
 * settle CASes on the `activeTurns` entry the stop just deleted, and the stop's
 * own sandbox-scoped settle has already run. A row created after that instant is
 * open for ever on a box that is parked, which is precisely the permanent
 * phantom-busy state this table exists to end.
 *
 * These tests drive the SHIPPED functions and commit a REAL stop in that exact
 * gap, so the interleaving is executed rather than argued about.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realDbModule from '../shared/db';

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `turn-stop-race-${SANDBOX_ID}`;
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const t = (name: string) => `${name}-${SANDBOX_ID}`;

/**
 * Run one action in the gap AFTER the module under test's next `skip` database
 * round trips and BEFORE the one after them. Single-threaded interception is
 * the only way to place a committed transaction between two statements of a
 * function that exposes no seam between them.
 */
let gate: { skip: number; action: () => Promise<void> } | null = null;
function runBeforeRoundTrip(skip: number, action: () => Promise<void>) {
  gate = { skip, action };
}

const db = new Proxy(realDbModule.db, {
  get(target, prop, receiver) {
    if (prop !== 'execute') return Reflect.get(target, prop, receiver);
    return async (query: unknown) => {
      if (gate) {
        if (gate.skip > 0) gate.skip -= 1;
        else {
          // Cleared BEFORE the action runs: the action is itself a database
          // writer and must not intercept its own round trips.
          const { action } = gate;
          gate = null;
          await action();
        }
      }
      return target.execute(query as never);
    };
  },
});

mock.module('../shared/db', () => ({ ...realDbModule, db, auditDb: db }));

const { acceptSandboxTurn, beginSandboxTurn, settleOpenSandboxTurns, settleOrphanedSandboxTurns } =
  await import('../projects/sandbox-turn-lifecycle');
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
  gate = null;
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
});

describe("a stop committed between a turn writer's two round trips", () => {
  test('beginSandboxTurn writes no ledger row once the stop has erased its authority', async () => {
    // 1 round trip through: the authority UPDATE. The stop then commits, and
    // the delayed ledger INSERT arrives at a sandbox that is already parked.
    runBeforeRoundTrip(1, stopTheBox);

    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('race-begin'), opencodeSessionId: 'ses_root', messageId: 'msg_race_begin' },
        60_000,
      ),
    ).toBe('granted');

    // Nothing could ever close such a row: clearSandboxTurn requires
    // `status = 'active'`, completeSandboxTurn requires active/provisioning,
    // abandonSandboxTurn needs the erased metadata entry, and the stop's
    // sandbox-scoped settle already ran. So it must never be created.
    expect(await readTurn(t('race-begin'))).toBeUndefined();
    expect(await openRows()).toBe(0);
  });

  test('acceptSandboxTurn writes no ledger row for a boot turn the stop already erased', async () => {
    // A boot turn goes straight into metadata (initialSandboxTurnMetadata) and
    // never passes through beginSandboxTurn, so acceptance is its FIRST ledger
    // write — an INSERT of a row in state 'active', with the same window.
    await realDbModule.db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET metadata = jsonb_build_object('activeTurns', jsonb_build_object(
               ${t('race-boot')}::text, jsonb_build_object(
                 'token', ${t('race-boot')}::text,
                 'state', 'delivering',
                 'opencodeSessionId', 'ses_root',
                 'messageId', 'msg_race_boot',
                 'startedAtMs', 1)))
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    runBeforeRoundTrip(1, stopTheBox);

    expect(
      await acceptSandboxTurn({ sandboxId: SANDBOX_ID }, t('race-boot'), {
        opencodeSessionId: 'ses_root',
        messageId: 'msg_race_boot',
      }),
    ).toBe(true);

    expect(await readTurn(t('race-boot'))).toBeUndefined();
    expect(await openRows()).toBe(0);
  });

  test('a turn whose ledger row already exists is settled by the stop, not lost', async () => {
    // The ordinary ordering, as the control: both round trips land, then the
    // stop settles the row it can see.
    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('race-settled'), opencodeSessionId: 'ses_root', messageId: 'msg_race_settled' },
        60_000,
      ),
    ).toBe('granted');
    expect(await readTurn(t('race-settled'))).toMatchObject({ state: 'delivering' });

    await stopTheBox();

    expect(await readTurn(t('race-settled'))).toMatchObject({
      state: 'ended',
      end_reason: 'runtime_gone',
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
    expect(await settleOrphanedSandboxTurns()).toBeGreaterThanOrEqual(0);
    expect(await readTurn(t('orphan-live'))).toMatchObject({ state: 'delivering' });

    await realDbModule.db.execute(sql`
      UPDATE kortix.session_sandboxes SET status = 'stopped'
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    expect(await settleOrphanedSandboxTurns()).toBeGreaterThanOrEqual(2);
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
    // USABLE for this predicate — a predicate it cannot serve stays a seq scan
    // even here.
    const plan = await realDbModule.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return rows(
        await tx.execute(sql`
          EXPLAIN UPDATE kortix.session_turns t
                     SET state = 'ended'
                   WHERE t.state <> 'ended'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM kortix.session_sandboxes s
                        WHERE s.sandbox_id = t.sandbox_id
                          AND s.status IN ('active', 'provisioning'))`),
      )
        .map((row) => String(Object.values(row)[0]))
        .join('\n');
    });

    expect(plan).toContain('session_turns_open_idx');
  });
});
