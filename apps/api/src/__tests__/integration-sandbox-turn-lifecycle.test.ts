/**
 * Integration test (real local PostgreSQL): durable per-turn lifecycle
 * authority and the prompt-versus-stop linearization point.
 *
 * String-rendering unit tests cannot prove JSONB selection or concurrent turn
 * isolation. These tests execute the shipped SQL against session_sandboxes.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { claimExpiredSandboxStop, releaseSandboxStopClaim } from '../projects/reaping/box-queries';
import {
  clearPendingStopObservation,
  markPendingStopObservation,
} from '../projects/reaping/sandbox-state-sync';
import { sandboxStopClaimLeaseMs } from '../projects/sandbox-deadline-policy';
import {
  abandonSandboxTurn,
  acceptSandboxTurn,
  adoptRuntimeSandboxTurn,
  beginSandboxTurn,
  clearSandboxTurn,
  clearTurnStopRequest,
  completeSandboxTurn,
  markTurnStopRequested,
  recordUnidentifiedTurnCause,
  reconcileSandboxTurnDelivery,
  settleOpenSandboxTurnsQuery,
} from '../projects/sandbox-turn-lifecycle';
import { db } from '../shared/db';

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `turn-lifecycle-${SANDBOX_ID}`;
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();

/**
 * A fixture turn token, scoped to THIS run.
 *
 * `turn_token` is the PRIMARY KEY of `kortix.session_turns`, and the repo's
 * default local setup points every worktree at ONE Postgres, so a fixed token
 * is a row that two concurrent runs of this file fight over: one run's insert
 * loses its `ON CONFLICT DO NOTHING` against the other's row and reads back a
 * foreign session, and any sweep wide enough to clear a dead run's rows deletes
 * a live run's mid-assertion. Every other identifier in this file is already
 * per-run; tokens now are too, so no cleanup ever has to reach past this run.
 */
const t = (name: string) => `${name}-${SANDBOX_ID}`;

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const rows = (result: unknown) => (result as Rows).rows ?? (result as Rows);

async function readRow(): Promise<{
  metadata: Record<string, unknown>;
  deadlineAt: Date | string;
}> {
  const result = await db.execute(sql`
    SELECT metadata, deadline_at AS "deadlineAt"
      FROM kortix.session_sandboxes
     WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  return rows(result)[0] as {
    metadata: Record<string, unknown>;
    deadlineAt: Date | string;
  };
}

const deadlineMs = (row: { deadlineAt: Date | string }) => new Date(row.deadlineAt).getTime();

async function readTurn(token: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute(sql`
    SELECT * FROM kortix.session_turns WHERE turn_token = ${token}`);
  return rows(result)[0];
}

async function setLifecycleState(
  metadata: Record<string, unknown>,
  deadline: 'live' | 'expired' = 'live',
): Promise<void> {
  await db.execute(sql`
    UPDATE kortix.session_sandboxes
       SET metadata = ${JSON.stringify(metadata)}::jsonb,
           deadline_at = now() + ${deadline === 'live' ? 600 : -1} * interval '1 second',
           status = 'active'
     WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
}

beforeEach(async () => {
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, metadata)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            'active', '{}'::jsonb)
    ON CONFLICT (sandbox_id) DO UPDATE
       SET status = 'active',
           metadata = '{}'::jsonb,
           deadline_at = now() + interval '10 minutes'`);
  // Tests inside one run share fixture tokens (`t('first')` appears in three),
  // and a settled row refuses to be settled again, so each test starts from an
  // empty ledger. Scoped to THIS run's session id and nothing else: a wider
  // sweep would delete the rows of a run happening concurrently on the same
  // local database, which is the repo's default worktree setup.
  await db.execute(sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`);
});

afterAll(async () => {
  await db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
});

describe('per-turn terminal isolation', () => {
  test('a terminal identified turn leaves a concurrent turn and its deadline intact', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('first')]: {
          token: t('first'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_first',
          startedAtMs: 1,
        },
        [t('second')]: {
          token: t('second'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_second',
          startedAtMs: 2,
        },
      },
    });
    const before = await readRow();

    await completeSandboxTurn(
      SESSION_ID,
      'idle',
      { opencodeSessionId: 'ses_root', messageId: 'msg_first' },
      undefined,
      60_000,
    );

    const after = await readRow();
    expect(after.metadata.activeTurns).toEqual({
      [t('second')]: {
        token: t('second'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_second',
        startedAtMs: 2,
      },
    });
    expect(deadlineMs(after)).toBe(deadlineMs(before));
  });

  test('the final terminal turn contracts the deadline', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('only')]: {
          token: t('only'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_only',
          startedAtMs: 1,
        },
      },
    });

    await completeSandboxTurn(
      SESSION_ID,
      'idle',
      { opencodeSessionId: 'ses_root', messageId: 'msg_only' },
      undefined,
      60_000,
    );

    const after = await readRow();
    expect(after.metadata.activeTurns).toEqual({});
    expect(deadlineMs(after)).toBeLessThanOrEqual(Date.now() + 60_500);
  });

  test('reaper recovery of the final terminal turn contracts the deadline', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('only')]: {
          token: t('only'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_only',
          startedAtMs: 1,
        },
      },
    });

    expect(await clearSandboxTurn(SANDBOX_ID, t('only'), 60_000)).toBe(true);

    const after = await readRow();
    expect(after.metadata.activeTurns).toEqual({});
    expect(deadlineMs(after)).toBeLessThanOrEqual(Date.now() + 60_500);
  });

  test('a stale identified terminal event cannot remove a newer identified turn', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('newer')]: {
          token: t('newer'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_newer',
          startedAtMs: 2,
        },
      },
    });
    const before = await readRow();

    const result = await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_old',
    });

    const after = await readRow();
    expect(result).toEqual({
      outcome: 'identity_mismatch',
      activeTurnCount: 1,
      closedTurnCount: 0,
    });
    expect(after.metadata.activeTurns).toEqual(before.metadata.activeTurns);
    expect(deadlineMs(after)).toBe(deadlineMs(before));
  });

  test('a terminal event for another root reports identity_mismatch', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('another-root')]: {
          token: t('another-root'),
          state: 'active',
          opencodeSessionId: 'ses_current_root',
          messageId: 'msg_current_root',
          startedAtMs: 2,
        },
      },
    });
    const before = await readRow();

    const result = await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_stale_root',
      messageId: 'msg_stale_root',
    });

    expect(result).toEqual({
      outcome: 'identity_mismatch',
      activeTurnCount: 1,
      closedTurnCount: 0,
    });
    expect((await readRow()).metadata.activeTurns).toEqual(before.metadata.activeTurns);
  });

  test('a retried exact terminal identity reports already_closed without another mutation', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      {
        token: t('retry-complete'),
        opencodeSessionId: 'ses_root',
        messageId: 'msg_retry_complete',
      },
      60_000,
    );

    const first = await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_retry_complete',
    });
    const retry = await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_retry_complete',
    });

    expect(first.outcome).toBe('closed');
    expect(retry).toEqual({
      outcome: 'already_closed',
      activeTurnCount: 0,
      closedTurnCount: 0,
    });
    expect((await readRow()).metadata.activeTurns).toEqual({});
    expect(await readTurn(t('retry-complete'))).toMatchObject({
      state: 'ended',
      end_reason: 'completed',
    });
  });

  test('a closed identity remains already_closed while a newer turn is active', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      {
        token: t('closed-before-newer'),
        opencodeSessionId: 'ses_root',
        messageId: 'msg_closed_before_newer',
      },
      60_000,
    );
    expect(
      (
        await completeSandboxTurn(SESSION_ID, 'idle', {
          opencodeSessionId: 'ses_root',
          messageId: 'msg_closed_before_newer',
        })
      ).outcome,
    ).toBe('closed');

    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      {
        token: t('newer-after-closed'),
        opencodeSessionId: 'ses_root',
        messageId: 'msg_newer_after_closed',
      },
      60_000,
    );
    const before = await readRow();

    const retry = await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_closed_before_newer',
    });

    expect(retry).toEqual({
      outcome: 'already_closed',
      activeTurnCount: 1,
      closedTurnCount: 0,
    });
    expect((await readRow()).metadata.activeTurns).toEqual(before.metadata.activeTurns);
    expect(await readTurn(t('newer-after-closed'))).toMatchObject({ state: 'delivering' });
  });

  test('an exact message does not consume a queued command record', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('command')]: {
          token: t('command'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: null,
          startedAtMs: 1,
        },
        [t('exact')]: {
          token: t('exact'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_exact',
          startedAtMs: 2,
        },
      },
    });

    await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_exact',
    });

    expect((await readRow()).metadata.activeTurns).toEqual({
      [t('command')]: {
        token: t('command'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: null,
        startedAtMs: 1,
      },
    });
  });

  test('terminal command evidence removes only the oldest null-message record', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('older')]: {
          token: t('older'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: null,
          startedAtMs: 1,
        },
        [t('newer')]: {
          token: t('newer'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: null,
          startedAtMs: 2,
        },
      },
    });

    await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: null,
    });

    expect((await readRow()).metadata.activeTurns).toEqual({
      [t('newer')]: {
        token: t('newer'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: null,
        startedAtMs: 2,
      },
    });
  });

  test('a failed newer delivery removes only its token', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('older')]: {
          token: t('older'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_older',
          startedAtMs: 1,
        },
        [t('newer')]: {
          token: t('newer'),
          state: 'delivering',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_newer',
          startedAtMs: 2,
        },
      },
    });

    expect(await abandonSandboxTurn({ sandboxId: SANDBOX_ID }, t('newer'))).toBe(true);

    expect((await readRow()).metadata.activeTurns).toEqual({
      [t('older')]: {
        token: t('older'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_older',
        startedAtMs: 1,
      },
    });
  });

  test('reaper cleanup cannot overwrite a turn committed while it waits for the row', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('first')]: {
          token: t('first'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_first',
          startedAtMs: 1,
        },
      },
    });

    let writerHasLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      writerHasLock = resolve;
    });
    let releaseWriter!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE kortix.session_sandboxes
           SET metadata = jsonb_set(
             metadata,
             '{activeTurns}',
             metadata->'activeTurns' || jsonb_build_object(
               ${t('second')}::text,
               jsonb_build_object(
                 'token', ${t('second')}::text,
                 'state', 'active',
                 'opencodeSessionId', 'ses_root',
                 'messageId', 'msg_second',
                 'startedAtMs', 2)),
             true)
         WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
      writerHasLock();
      await release;
    });
    await locked;

    const cleanup = clearSandboxTurn(SANDBOX_ID, t('first'), 60_000);
    await Bun.sleep(50);
    releaseWriter();
    await Promise.all([writer, cleanup]);

    expect((await readRow()).metadata.activeTurns).toEqual({
      [t('second')]: {
        token: t('second'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_second',
        startedAtMs: 2,
      },
    });
  });

  test('terminal relay cannot overwrite a turn committed while it waits for the row', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('first')]: {
          token: t('first'),
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_first',
          startedAtMs: 1,
        },
      },
    });

    let writerHasLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      writerHasLock = resolve;
    });
    let releaseWriter!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE kortix.session_sandboxes
           SET metadata = jsonb_set(
             metadata,
             '{activeTurns}',
             metadata->'activeTurns' || jsonb_build_object(
               ${t('second')}::text,
               jsonb_build_object(
                 'token', ${t('second')}::text,
                 'state', 'active',
                 'opencodeSessionId', 'ses_root',
                 'messageId', 'msg_second',
                 'startedAtMs', 2)),
             true)
         WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
      writerHasLock();
      await release;
    });
    await locked;

    const cleanup = completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_first',
    });
    await Bun.sleep(50);
    releaseWriter();
    await Promise.all([writer, cleanup]);

    expect((await readRow()).metadata.activeTurns).toEqual({
      [t('second')]: {
        token: t('second'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_second',
        startedAtMs: 2,
      },
    });
  });
});

describe('prompt-versus-stop linearization', () => {
  test('an active turn can begin after 24 hours without losing lifecycle authority', async () => {
    const observedAtMs = Date.now() + 24 * 60 * 60 * 1000 + 60_000;

    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('at-cap'), opencodeSessionId: 'ses_root', messageId: 'msg_at_cap' },
        60_000,
        observedAtMs,
      ),
    ).toBe('granted');
    const row = await readRow();
    expect(row.metadata.activeTurns).toHaveProperty(t('at-cap'));
    expect(deadlineMs(row)).toBeGreaterThanOrEqual(observedAtMs + 59_000);
  });

  test('a malformed legacy metadata value is normalized before turn creation', async () => {
    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET metadata = '[]'::jsonb
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('normalized'), opencodeSessionId: 'ses_root', messageId: 'msg_normalized' },
        60_000,
      ),
    ).toBe('granted');
    expect((await readRow()).metadata.activeTurns).toHaveProperty(t('normalized'));
  });

  test('a malformed legacy metadata value does not prevent an expired stop claim', async () => {
    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET metadata = '"legacy"'::jsonb,
             deadline_at = now() - interval '1 minute'
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    expect(await claimExpiredSandboxStop(SANDBOX_ID, 'normalized-stop')).toBe(true);
    expect((await readRow()).metadata.lifecycleStopClaim).toEqual({
      token: 'normalized-stop',
      claimedAtMs: expect.any(Number),
    });
  });

  test('a prompt that commits first prevents the stop claim', async () => {
    await setLifecycleState({}, 'expired');

    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('prompt-first'), opencodeSessionId: 'ses_root', messageId: 'msg_first' },
        60_000,
      ),
    ).toBe('granted');
    expect(await claimExpiredSandboxStop(SANDBOX_ID, 'stop-second')).toBe(false);
  });

  test('a stop claim that commits first blocks prompt delivery authority', async () => {
    await setLifecycleState({}, 'expired');

    expect(await claimExpiredSandboxStop(SANDBOX_ID, 'stop-first')).toBe(true);
    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('prompt-second'), opencodeSessionId: 'ses_root', messageId: 'msg_second' },
        60_000,
      ),
    ).toBe('no_box');
    expect((await readRow()).metadata.activeTurns).toBeUndefined();
  });

  test('an expired stop claim is recoverable by a new prompt', async () => {
    await setLifecycleState({
      lifecycleStopClaim: {
        token: 'expired-stop',
        // A MINUTE past the lease, not a millisecond: the claim is stamped
        // from this process's clock and the expiry is evaluated against
        // Postgres's `now()`. The local database runs in a Docker VM whose
        // clock currently trails the host by ~28 ms, so a 1 ms margin made this
        // assertion a coin flip on skew rather than a test of the rule.
        claimedAtMs: Date.now() - sandboxStopClaimLeaseMs() - 60_000,
      },
    });

    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('recovery'), opencodeSessionId: 'ses_root', messageId: 'msg_recovery' },
        60_000,
      ),
    ).toBe('granted');
    const metadata = (await readRow()).metadata;
    expect(metadata.lifecycleStopClaim).toBeUndefined();
    expect(metadata.activeTurns).toHaveProperty(t('recovery'));
  });

  test('claim release is token-scoped', async () => {
    await setLifecycleState({}, 'expired');
    expect(await claimExpiredSandboxStop(SANDBOX_ID, 'owned-claim')).toBe(true);

    await releaseSandboxStopClaim(SANDBOX_ID, 'different-claim');
    expect((await readRow()).metadata.lifecycleStopClaim).toEqual({
      token: 'owned-claim',
      claimedAtMs: expect.any(Number),
    });

    await releaseSandboxStopClaim(SANDBOX_ID, 'owned-claim');
    expect((await readRow()).metadata.lifecycleStopClaim).toBeUndefined();
  });

  test('no idle stop claim can override active-turn authority', async () => {
    await setLifecycleState(
      {
        activeTurns: {
          [t('turn-active')]: {
            token: t('turn-active'),
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_active',
            startedAtMs: 1,
          },
        },
      },
      'expired',
    );

    expect(await claimExpiredSandboxStop(SANDBOX_ID, 'idle-stop')).toBe(false);
    expect(await claimExpiredSandboxStop(SANDBOX_ID, 'second-idle-stop')).toBe(false);
    expect((await readRow()).metadata.lifecycleStopClaim).toBeUndefined();
  });
});

describe('session_turns ledger', () => {
  test('beginSandboxTurn writes a delivering ledger row with full identity', async () => {
    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: t('ledger-begin'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_begin' },
        60_000,
      ),
    ).toBe('granted');

    const turn = await readTurn(t('ledger-begin'));
    expect(turn).toMatchObject({
      session_id: SESSION_ID,
      sandbox_id: SANDBOX_ID,
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      opencode_session_id: 'ses_root',
      message_id: 'msg_ledger_begin',
      state: 'delivering',
      end_reason: null,
      accepted_at: null,
      ended_at: null,
    });
    expect(new Date(turn?.started_at as string).getTime()).toBeGreaterThan(0);
  });

  test('acceptSandboxTurn promotes the same row and stamps accepted_at', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-accept'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_accept' },
      60_000,
    );

    expect(
      await acceptSandboxTurn({ sandboxId: SANDBOX_ID }, t('ledger-accept'), {
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_accept',
      }),
    ).toBe(true);

    const turn = await readTurn(t('ledger-accept'));
    expect(turn?.state).toBe('active');
    expect(new Date(turn?.accepted_at as string).getTime()).toBeGreaterThan(0);
    expect(turn?.ended_at).toBeNull();
  });

  test('acceptSandboxTurn creates the row for a daemon-delivered boot turn', async () => {
    // initialSandboxTurnMetadata writes this entry at provision time; it never
    // passes through beginSandboxTurn, so acceptance must UPSERT, not UPDATE.
    await setLifecycleState({
      activeTurns: {
        [t('ledger-boot')]: {
          token: t('ledger-boot'),
          state: 'delivering',
          opencodeSessionId: null,
          messageId: 'msg_ledger_boot',
          startedAtMs: 1,
        },
      },
    });

    expect(
      await acceptSandboxTurn({ sandboxId: SANDBOX_ID }, t('ledger-boot'), {
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_boot',
      }),
    ).toBe(true);

    expect(await readTurn(t('ledger-boot'))).toMatchObject({
      session_id: SESSION_ID,
      state: 'active',
      opencode_session_id: 'ses_root',
      message_id: 'msg_ledger_boot',
    });
  });

  test('acceptSandboxTurn creates the row for a legacy single-record turn', async () => {
    // The rolling-deploy arm: a turn written by an older writer lives under
    // `activeTurn`, not `activeTurns`. The insert's authority guard has to
    // accept it too, or a whole deploy window records no history at all.
    await setLifecycleState({
      activeTurn: {
        token: t('ledger-legacy-accept'),
        state: 'delivering',
        opencodeSessionId: null,
        messageId: 'msg_ledger_legacy_accept',
        startedAtMs: 1,
      },
    });

    expect(
      await acceptSandboxTurn({ sandboxId: SANDBOX_ID }, t('ledger-legacy-accept'), {
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_legacy_accept',
      }),
    ).toBe(true);

    expect(await readTurn(t('ledger-legacy-accept'))).toMatchObject({
      session_id: SESSION_ID,
      state: 'active',
      opencode_session_id: 'ses_root',
      message_id: 'msg_ledger_legacy_accept',
    });
  });

  test('completeSandboxTurn retains the row as ended while activeTurns loses the entry', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      {
        token: t('ledger-complete'),
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_complete',
      },
      60_000,
    );

    expect(
      await completeSandboxTurn(
        SESSION_ID,
        'idle',
        { opencodeSessionId: 'ses_root', messageId: 'msg_ledger_complete' },
        undefined,
        60_000,
      ),
    ).toEqual({ outcome: 'closed', activeTurnCount: 1, closedTurnCount: 1 });

    // This assertion pair is the entire point of the table: the lifecycle
    // authority forgets the turn, the ledger remembers how it ended.
    expect((await readRow()).metadata.activeTurns).toEqual({});
    const turn = await readTurn(t('ledger-complete'));
    expect(turn?.state).toBe('ended');
    expect(turn?.end_reason).toBe('completed');
    expect(new Date(turn?.ended_at as string).getTime()).toBeGreaterThan(0);
  });

  test("completeSandboxTurn records 'failed' for a terminal error end", async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-failed'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_failed' },
      60_000,
    );

    await completeSandboxTurn(
      SESSION_ID,
      'error',
      { opencodeSessionId: 'ses_root', messageId: 'msg_ledger_failed' },
      undefined,
      60_000,
    );

    expect(await readTurn(t('ledger-failed'))).toMatchObject({
      state: 'ended',
      end_reason: 'failed',
    });
  });

  test('clearSandboxTurn records runtime_gone and retains the row', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-clear'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_clear' },
      60_000,
    );

    expect(await clearSandboxTurn(SANDBOX_ID, t('ledger-clear'), 60_000)).toBe(true);

    expect((await readRow()).metadata.activeTurns).toEqual({});
    expect(await readTurn(t('ledger-clear'))).toMatchObject({
      state: 'ended',
      end_reason: 'runtime_gone',
    });
  });

  test('abandonSandboxTurn settles the row instead of leaving it delivering', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      {
        token: t('ledger-abandon'),
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_abandon',
      },
      60_000,
    );

    expect(await abandonSandboxTurn({ sandboxId: SANDBOX_ID }, t('ledger-abandon'))).toBe(true);

    // Every failed delivery takes this path (preview.ts 3xx/401/503/4xx/
    // unreachable, turn-stream.ts turn_abandoned). Leaving the row 'delivering' makes
    // the ledger claim a turn is running for ever.
    expect((await readRow()).metadata.activeTurns).toEqual({});
    expect(await readTurn(t('ledger-abandon'))).toMatchObject({
      state: 'ended',
      end_reason: 'abandoned',
      opencode_session_id: 'ses_root',
      message_id: 'msg_ledger_abandon',
    });
  });

  test('abandonSandboxTurn records a boot turn that never reached the ledger', async () => {
    // initialSandboxTurnMetadata writes this at provision time; the daemon can
    // report `turn_abandoned` before any accept, so this is the row's only
    // chance to exist at all.
    await setLifecycleState({
      activeTurns: {
        [t('ledger-boot-abandon')]: {
          token: t('ledger-boot-abandon'),
          state: 'delivering',
          opencodeSessionId: null,
          messageId: 'msg_boot_abandon',
          startedAtMs: 1,
        },
      },
    });

    expect(await abandonSandboxTurn({ sandboxId: SANDBOX_ID }, t('ledger-boot-abandon'))).toBe(
      true,
    );

    expect(await readTurn(t('ledger-boot-abandon'))).toMatchObject({
      session_id: SESSION_ID,
      state: 'ended',
      end_reason: 'abandoned',
      message_id: 'msg_boot_abandon',
    });
  });

  test('completeSandboxTurn writes history for a turn that has no ledger row', async () => {
    await setLifecycleState({
      activeTurns: {
        [t('ledger-boot-complete')]: {
          token: t('ledger-boot-complete'),
          state: 'delivering',
          opencodeSessionId: null,
          messageId: 'msg_boot_complete',
          startedAtMs: 1,
        },
      },
    });

    expect(
      await completeSandboxTurn(
        SESSION_ID,
        'idle',
        { opencodeSessionId: 'ses_root', messageId: 'msg_boot_complete' },
        undefined,
        60_000,
      ),
    ).toEqual({ outcome: 'closed', activeTurnCount: 1, closedTurnCount: 1 });

    expect(await readTurn(t('ledger-boot-complete'))).toMatchObject({
      session_id: SESSION_ID,
      sandbox_id: SANDBOX_ID,
      state: 'ended',
      end_reason: 'completed',
      message_id: 'msg_boot_complete',
    });
  });

  test('the legacy activeTurn record settles its ledger row under its own token', async () => {
    // The legacy arm's metadata KEY is the literal string 'activeTurn'; only
    // its `token` field names the row. Carrying the key into the ledger would
    // end a row that never existed and leave this one open for ever.
    await setLifecycleState({
      activeTurn: {
        token: t('ledger-legacy'),
        state: 'active',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_legacy',
        startedAtMs: 1,
      },
    });

    expect(
      await completeSandboxTurn(
        SESSION_ID,
        'idle',
        { opencodeSessionId: 'ses_root', messageId: 'msg_ledger_legacy' },
        undefined,
        60_000,
      ),
    ).toEqual({ outcome: 'closed', activeTurnCount: 1, closedTurnCount: 1 });

    expect((await readRow()).metadata.activeTurn).toBeUndefined();
    expect(await readTurn(t('ledger-legacy'))).toMatchObject({
      state: 'ended',
      end_reason: 'completed',
      message_id: 'msg_ledger_legacy',
    });
    expect(await readTurn('activeTurn')).toBeUndefined();
  });

  test('a fast terminal end keeps the row ended when the delivering insert lands later', async () => {
    // beginSandboxTurn's ledger INSERT is a second round trip after the
    // authority write, so a terminal end can settle the token before it lands.
    // The settle CREATES the ended row, so the late insert's
    // ON CONFLICT DO NOTHING loses instead of resurrecting 'delivering'.
    await setLifecycleState({
      activeTurns: {
        [t('ledger-race')]: {
          token: t('ledger-race'),
          state: 'delivering',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_ledger_race',
          startedAtMs: 1,
        },
      },
    });
    await completeSandboxTurn(
      SESSION_ID,
      'idle',
      { opencodeSessionId: 'ses_root', messageId: 'msg_ledger_race' },
      undefined,
      60_000,
    );
    expect(await readTurn(t('ledger-race'))).toMatchObject({ state: 'ended' });

    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-race'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_race' },
      60_000,
    );

    expect(await readTurn(t('ledger-race'))).toMatchObject({
      state: 'ended',
      end_reason: 'completed',
    });
  });

  test('a delivering turn the daemon cannot account for is recorded abandoned', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      {
        token: t('ledger-terminal'),
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_terminal',
      },
      60_000,
    );

    expect(await reconcileSandboxTurnDelivery(SANDBOX_ID, t('ledger-terminal'), 'terminal')).toBe(
      'inactive',
    );

    // This function only ever sees turns still in `delivering` — turns NOTHING
    // has confirmed reached OpenCode. `terminal` is only turn_in_flight ===
    // false, which the daemon answers for a prompt it never received exactly as
    // for one that finished, so with no reason from it the honest record is the
    // delivery that was never confirmed.
    expect(await readTurn(t('ledger-terminal'))).toMatchObject({
      state: 'ended',
      end_reason: 'abandoned',
    });
  });

  test('a delivering turn the daemon says completed keeps that reason', async () => {
    // The other half of the same rule: a lost promotion write leaves a turn
    // stuck in `delivering` while OpenCode really did run it to completion.
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      {
        token: t('ledger-terminal-done'),
        opencodeSessionId: 'ses_root',
        messageId: 'msg_ledger_terminal_done',
      },
      60_000,
    );

    expect(
      await reconcileSandboxTurnDelivery(
        SANDBOX_ID,
        t('ledger-terminal-done'),
        'terminal',
        'completed',
      ),
    ).toBe('inactive');

    expect(await readTurn(t('ledger-terminal-done'))).toMatchObject({
      state: 'ended',
      end_reason: 'completed',
    });
  });

  test('session_turns_open_idx serves the stop writer predicate', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-plan'), opencodeSessionId: 'ses_root', messageId: 'msg_plan' },
      60_000,
    );

    // Terminal rows are retained for ever, so the stop path must not degrade
    // into a sequential scan over the whole history as the table grows. On a
    // near-empty table a seq scan is the correct plan, so this asserts the
    // partial index is USABLE for the SHIPPED statement (the one
    // applyStoppedState runs), not that it is chosen today: a predicate the
    // index cannot serve stays a seq scan even here.
    const text = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const plan = await tx.execute(
        sql`EXPLAIN ${settleOpenSandboxTurnsQuery(SANDBOX_ID, 'runtime_gone')}`,
      );
      return rows(plan)
        .map((row) => String(Object.values(row)[0]))
        .join('\n');
    });
    expect(text).toContain('session_turns_open_idx');
  });

  test('the state and end_reason CHECK constraints reject an unknown value', async () => {
    const insert = async (state: string, endReason: string | null) =>
      await db.execute(sql`
        INSERT INTO kortix.session_turns
          (turn_token, session_id, sandbox_id, project_id, account_id, state, end_reason)
        VALUES (${`bogus-${state}-${endReason}`}, ${SESSION_ID}, ${SANDBOX_ID}::uuid,
                ${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, ${state}, ${endReason})`);

    // Drizzle wraps the driver error, so the constraint name is only on `cause`.
    const rejection = async (state: string, endReason: string | null) => {
      try {
        await insert(state, endReason);
      } catch (error) {
        return (error as { cause?: { message?: string } }).cause?.message ?? String(error);
      }
      return 'the insert was accepted';
    };

    expect(await rejection('bogus', null)).toContain('session_turns_state_check');
    expect(await rejection('ended', 'exploded')).toContain('session_turns_end_reason_check');
  });
});

describe('adoptRuntimeSandboxTurn — box-initiated turn authority', () => {
  // OpenCode starts turns of its own (synthetic `<pty_exited>` wake-ups) that
  // no control-plane prompt announced. The daemon relays `turn_begin` for
  // them; this write is what turns that relay into `GET .../turn` truth and a
  // deadline grant (live incident 2026-08-20, a prod session).
  const SYNTH = 'msg_synthetic_pty_1';

  async function readOpenBySession(): Promise<Array<Record<string, unknown>>> {
    const result = await db.execute(sql`
      SELECT * FROM kortix.session_turns
       WHERE session_id = ${SESSION_ID} AND state <> 'ended'`);
    return rows(result) as Array<Record<string, unknown>>;
  }

  test('adopts a box-initiated turn: active ledger row, activeTurns record, deadline grant', async () => {
    const before = deadlineMs(await readRow());
    const outcome = await adoptRuntimeSandboxTurn(SANDBOX_ID, {
      opencodeSessionId: 'ses_root',
      messageId: SYNTH,
    });
    expect(outcome).toBe('adopted');
    const open = await readOpenBySession();
    expect(open).toHaveLength(1);
    expect(open[0]?.message_id).toBe(SYNTH);
    expect(open[0]?.state).toBe('active');
    expect(open[0]?.accepted_at).toBeTruthy();
    const row = await readRow();
    const turns = (row.metadata as { activeTurns?: Record<string, { messageId?: string }> })
      .activeTurns;
    expect(Object.values(turns ?? {}).some((turn) => turn.messageId === SYNTH)).toBe(true);
    // acceptSandboxTurn grants the full turn deadline — hours past the
    // fixture's 10-minute deadline. Without it a long pty-driven work phase
    // ran on the idle tail and the reaper parked the box mid-work.
    expect(deadlineMs(row)).toBeGreaterThan(before + 60 * 60 * 1000);
  });

  test('any open turn means authority is already held — nothing is written', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('already-open'), opencodeSessionId: 'ses_root', messageId: 'msg_delivered_1' },
    );
    const outcome = await adoptRuntimeSandboxTurn(SANDBOX_ID, {
      opencodeSessionId: 'ses_root',
      messageId: SYNTH,
    });
    expect(outcome).toBe('open_turn_exists');
    const open = await readOpenBySession();
    expect(open).toHaveLength(1);
    expect(open[0]?.message_id).toBe('msg_delivered_1');
  });

  test('a message the ledger has EVER seen is refused — a late relay cannot resurrect a closed turn', async () => {
    await db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id, message_id, state, end_reason)
      VALUES (${t('closed')}, ${SESSION_ID}, ${SANDBOX_ID}::uuid,
              ${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, ${SYNTH}, 'ended', 'completed')`);
    const outcome = await adoptRuntimeSandboxTurn(SANDBOX_ID, {
      opencodeSessionId: 'ses_root',
      messageId: SYNTH,
    });
    expect(outcome).toBe('known_message');
    expect(await readOpenBySession()).toHaveLength(0);
  });
});

// Why a failed turn ended, and who asked. Every assertion reads the row back
// from Postgres: the rule lives in SQL (an upsert CASE and two guarded UPDATEs),
// so a test that only inspected the statement text could not fail.
describe('end_error: causes, requested stops, and which one wins', () => {
  const ROOT = 'ses_root';
  const MSG = 'msg_running';
  const ABORT = { name: 'MessageAbortedError', message: 'Aborted' };
  const GUARD = { name: 'SandboxMemoryGuard', message: 'sandbox memory at 97%' };

  /** One running turn: authority in the sandbox metadata, and its open ledger row. */
  async function openTurn(token = t('running'), messageId = MSG, opencodeSessionId = ROOT) {
    await setLifecycleState({
      activeTurns: {
        [token]: { token, state: 'active', opencodeSessionId, messageId, startedAtMs: 1 },
      },
    });
    await db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id,
         opencode_session_id, message_id, state, started_at, created_at, updated_at)
      VALUES (${token}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
              ${ACCOUNT_ID}::uuid, ${opencodeSessionId}, ${messageId}, 'active',
              now(), now(), now())`);
    return token;
  }
  const end = (error: { name: string; message: string } | undefined, status: 'idle' | 'error' = 'error') =>
    completeSandboxTurn(SESSION_ID, status, { opencodeSessionId: ROOT, messageId: MSG }, error, 60_000);

  test('an abort nobody asked for is recorded as the abort it is', async () => {
    const token = await openTurn();
    expect((await end(ABORT)).outcome).toBe('closed');
    const row = await readTurn(token);
    expect(row?.end_reason).toBe('failed');
    expect(row?.end_error).toEqual(ABORT);
  });

  test('a requested stop survives the abort it caused', async () => {
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'UserStop', { opencodeSessionId: ROOT });
    await end(ABORT);
    expect((await readTurn(token))?.end_error).toEqual({ name: 'UserStop', message: null });
  });

  // prod 2026-09-25: a web Stop's hold settle aborted the box ~450 ms before
  // the client's proxied abort. The first "Aborted" frame closed the turn, and
  // the proxy's stamp then found no open turn to mark.
  test('a stamp that lands after the abort closed the turn cannot rescue it', async () => {
    const token = await openTurn();
    await end(ABORT); // the settle's unstamped abort
    await markTurnStopRequested(SESSION_ID, 'UserStop', { opencodeSessionId: ROOT }); // proxy, too late
    await end(ABORT); // the client's abort
    expect((await readTurn(token))?.end_error).toEqual(ABORT);
  });

  test('the hold stamps first, so every later abort of the same Stop keeps it a stop', async () => {
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'UserStop', { opencodeSessionId: ROOT }); // hold route
    await end(ABORT); // the settle's abort
    await markTurnStopRequested(SESSION_ID, 'UserStop', { opencodeSessionId: ROOT }); // proxy
    await end(ABORT); // the client's abort
    const row = await readTurn(token);
    expect(row?.end_reason).toBe('failed');
    expect(row?.end_error).toEqual({ name: 'UserStop', message: null });
  });

  test('a named cause beats a requested stop: the mark never hides a real failure', async () => {
    // Stop pressed, the abort never landed, and the memory guard fired later.
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'UserStop', { opencodeSessionId: ROOT });
    await end(GUARD);
    expect((await readTurn(token))?.end_error).toEqual(GUARD);
  });

  test('a turn that completes drops the request that never fired', async () => {
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'QueueInterrupt', { opencodeSessionId: ROOT, messageId: MSG });
    await end(undefined, 'idle');
    const row = await readTurn(token);
    expect(row?.end_reason).toBe('completed');
    expect(row?.end_error).toBeNull();
  });

  test('a withdrawn queue interrupt leaves a later abort unexplained', async () => {
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'QueueInterrupt', { messageId: MSG });
    await clearTurnStopRequest(SESSION_ID, 'QueueInterrupt');
    await end(ABORT);
    expect((await readTurn(token))?.end_error).toEqual(ABORT);
  });

  test('clearing one kind of request leaves the other in place', async () => {
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'UserStop');
    await clearTurnStopRequest(SESSION_ID, 'QueueInterrupt');
    expect((await readTurn(token))?.end_error).toEqual({ name: 'UserStop', message: null });
  });

  test('a request is scoped: another OpenCode session or another message is untouched', async () => {
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'UserStop', { opencodeSessionId: 'ses_child' });
    expect((await readTurn(token))?.end_error).toBeNull();
    await markTurnStopRequested(SESSION_ID, 'QueueInterrupt', { messageId: 'msg_other' });
    expect((await readTurn(token))?.end_error).toBeNull();
  });

  test('a request never rewrites a turn that already ended', async () => {
    const token = await openTurn();
    await end(GUARD);
    await markTurnStopRequested(SESSION_ID, 'UserStop');
    expect((await readTurn(token))?.end_error).toEqual(GUARD);
  });

  test('a cause that arrives after the abort closed the turn replaces the abort, once', async () => {
    // A prod session: OpenCode's "Aborted" frame beat the guard's by 476 ms.
    const token = await openTurn();
    await end(ABORT);
    expect((await end(GUARD)).outcome).toBe('already_closed');
    expect((await readTurn(token))?.end_error).toEqual(GUARD);

    // A named cause is final: neither a late abort nor a second cause moves it.
    await end(ABORT);
    await end({ name: 'SomethingElse', message: 'later' });
    expect((await readTurn(token))?.end_error).toEqual(GUARD);
  });

  test('a late cause never turns a requested stop into a failure', async () => {
    const token = await openTurn();
    await markTurnStopRequested(SESSION_ID, 'UserStop');
    await end(ABORT);
    await end(GUARD);
    expect((await readTurn(token))?.end_error).toEqual({ name: 'UserStop', message: null });
  });
});

// A daemon built before the guard named its turn sends the cause with no
// `turn_message_id` and `error_retryable: true`. `completeSandboxTurn` drops that
// frame as `non_terminal`, so the UI said "No reason was reported" under a turn
// the memory guard stopped (prod 2026-09-22, daemon built 2026-09-18).
describe('recordUnidentifiedTurnCause: a cause frame that does not name its turn', () => {
  const ROOT = 'ses_root';
  const ABORT = { name: 'MessageAbortedError', message: 'Aborted' };
  const GUARD = { name: 'SandboxMemoryGuard', message: 'sandbox memory at 92%' };

  async function openTurn(token: string, messageId: string) {
    await setLifecycleState({
      activeTurns: {
        [token]: { token, state: 'active', opencodeSessionId: ROOT, messageId, startedAtMs: 1 },
      },
    });
    await db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id,
         opencode_session_id, message_id, state, started_at, created_at, updated_at)
      VALUES (${token}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
              ${ACCOUNT_ID}::uuid, ${ROOT}, ${messageId}, 'active', now(), now(), now())`);
    return token;
  }
  const end = (messageId: string, error: { name: string; message: string } | undefined, status: 'idle' | 'error' = 'error') =>
    completeSandboxTurn(SESSION_ID, status, { opencodeSessionId: ROOT, messageId }, error, 60_000);
  const cause = () => recordUnidentifiedTurnCause(SESSION_ID, ROOT, GUARD);

  test('the abort closed the turn first: the cause replaces that abort', async () => {
    const token = await openTurn(t('u-first'), 'msg_u1');
    await end('msg_u1', ABORT);
    expect(await cause()).toBe('refined_ended');
    expect((await readTurn(token))?.end_error).toEqual(GUARD);
  });

  test('the cause arrived first: it is held on the open turn and survives the abort', async () => {
    const token = await openTurn(t('u-open'), 'msg_u2');
    expect(await cause()).toBe('marked_open');
    await end('msg_u2', ABORT);
    const row = await readTurn(token);
    expect(row?.end_reason).toBe('failed');
    expect(row?.end_error).toEqual(GUARD);
  });

  test('the abort never landed and the turn completed: the held cause is dropped', async () => {
    const token = await openTurn(t('u-done'), 'msg_u3');
    await cause();
    await end('msg_u3', undefined, 'idle');
    const row = await readTurn(token);
    expect(row?.end_reason).toBe('completed');
    expect(row?.end_error).toBeNull();
  });

  test('a turn the abort just ended wins over the next turn that already started', async () => {
    const aborted = await openTurn(t('u-prev'), 'msg_u4');
    await end('msg_u4', ABORT);
    const next = await openTurn(t('u-next'), 'msg_u5');
    expect(await cause()).toBe('refined_ended');
    expect((await readTurn(aborted))?.end_error).toEqual(GUARD);
    expect((await readTurn(next))?.end_error).toBeNull();
  });

  test('an old abort, a requested stop, or another named cause is never rewritten', async () => {
    const old = await openTurn(t('u-old'), 'msg_u6');
    await end('msg_u6', ABORT);
    await db.execute(sql`UPDATE kortix.session_turns SET ended_at = now() - interval '5 minutes' WHERE turn_token = ${old}`);
    const stopped = await openTurn(t('u-stop'), 'msg_u7');
    await markTurnStopRequested(SESSION_ID, 'UserStop', { messageId: 'msg_u7' });
    await end('msg_u7', ABORT);
    const other = await openTurn(t('u-other'), 'msg_u8');
    await end('msg_u8', { name: 'APIError', message: 'upstream 500' });

    expect(await cause()).toBe('none');
    expect((await readTurn(old))?.end_error).toEqual(ABORT);
    expect((await readTurn(stopped))?.end_error).toEqual({ name: 'UserStop', message: null });
    expect((await readTurn(other))?.end_error).toEqual({ name: 'APIError', message: 'upstream 500' });
  });
});


// The reaper closes a turn whose end frame never arrived. `failed` with no
// cause was hidden from the UI entirely: the reader took it for a row older
// than the end_error column. The reaper now says what it saw, as a fallback
// that never overrides a stop somebody asked for.
describe('clearSandboxTurn: the reaper names what it saw', () => {
  const ROOT = 'ses_root';
  async function openTurn(token: string, messageId: string) {
    await setLifecycleState({
      activeTurns: {
        [token]: { token, state: 'active', opencodeSessionId: ROOT, messageId, startedAtMs: 1 },
      },
    });
    await db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id,
         opencode_session_id, message_id, state, started_at, created_at, updated_at)
      VALUES (${token}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid,
              ${ACCOUNT_ID}::uuid, ${ROOT}, ${messageId}, 'active', now(), now(), now())`);
    return token;
  }
  const HUSK = { name: 'TurnHuskFinalized', message: 'The agent stopped responding in the middle of this turn, so Kortix closed it.' };

  test('a failed clear records the cause it was given', async () => {
    const token = await openTurn(t('reap-husk'), 'msg_r1');
    expect(await clearSandboxTurn(SANDBOX_ID, token, 60_000, 'failed', HUSK)).toBe(true);
    const row = await readTurn(token);
    expect(row?.end_reason).toBe('failed');
    expect(row?.end_error).toEqual(HUSK);
  });

  test('the reaper cause never overrides a requested stop', async () => {
    const token = await openTurn(t('reap-stop'), 'msg_r2');
    await markTurnStopRequested(SESSION_ID, 'UserStop', { messageId: 'msg_r2' });
    await clearSandboxTurn(SANDBOX_ID, token, 60_000, 'failed', HUSK);
    expect((await readTurn(token))?.end_error).toEqual({ name: 'UserStop', message: null });
  });

  test('a turn the reaper finds completed drops the request that never fired', async () => {
    const token = await openTurn(t('reap-done'), 'msg_r4');
    await markTurnStopRequested(SESSION_ID, 'QueueInterrupt', { messageId: 'msg_r4' });
    await clearSandboxTurn(SANDBOX_ID, token, 60_000, 'completed');
    const row = await readTurn(token);
    expect(row?.end_reason).toBe('completed');
    expect(row?.end_error).toBeNull();
  });

  test('a clear without a cause still writes none', async () => {
    const token = await openTurn(t('reap-none'), 'msg_r3');
    await clearSandboxTurn(SANDBOX_ID, token, 60_000, 'runtime_gone');
    expect((await readTurn(token))?.end_error).toBeNull();
  });
});

// The first provider-`stopped` read of a box that holds turn authority does not
// park it: it arms this marker, and only a second read a full window later may
// park (reaping/sandbox-state-sync.ts `decideStoppedObservation`).
describe('the pending stop marker', () => {
  const ACTIVE_TURNS = {
    [t('marker-turn')]: { token: t('marker-turn'), state: 'active', messageId: 'msg_marker' },
  };

  async function setStatus(status: 'provisioning' | 'stopped'): Promise<void> {
    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET status = ${status}::kortix.session_sandbox_status
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  }

  test('records the instant of THIS observation as a merge that keeps turn authority and liveness', async () => {
    await setLifecycleState({ activeTurns: ACTIVE_TURNS, lastAliveAt: '2026-09-25T10:00:00.000Z' });

    // The reaper carries one pass clock through up to 100 provider round
    // trips. A marker stamped with it is backdated, and a later read from a
    // fresh-clock observer confirms a park inside one provider transition.
    const before = Date.now();
    await markPendingStopObservation(SANDBOX_ID);
    const after = Date.now();

    const { metadata } = await readRow();
    expect(typeof metadata.pendingStopObservedAtMs).toBe('number');
    expect(metadata.pendingStopObservedAtMs as number).toBeGreaterThanOrEqual(before);
    expect(metadata.pendingStopObservedAtMs as number).toBeLessThanOrEqual(after);
    expect(metadata.activeTurns).toEqual(ACTIVE_TURNS);
    expect(metadata.lastAliveAt).toBe('2026-09-25T10:00:00.000Z');
  });

  test('never resets a marker that is already counting', async () => {
    // A second pass must be able to CONFIRM. A write that restarted the window
    // on every pass would mean the box never parks.
    await setLifecycleState({ activeTurns: ACTIVE_TURNS, pendingStopObservedAtMs: 1234 });

    await markPendingStopObservation(SANDBOX_ID);

    expect((await readRow()).metadata.pendingStopObservedAtMs).toBe(1234);
  });

  test('re-records a marker nothing can read', async () => {
    await setLifecycleState({ activeTurns: ACTIVE_TURNS, pendingStopObservedAtMs: 'soon' });

    await markPendingStopObservation(SANDBOX_ID);

    expect(typeof (await readRow()).metadata.pendingStopObservedAtMs).toBe('number');
  });

  // A `provisioning` row holds turn authority too (in-place recovery keeps
  // `activeTurns`). A CAS that matched only `active` left such a row at
  // `await_confirmation` for ever: never parked, its turns open for ever.
  test('arms a provisioning row, and never a parked one', async () => {
    await setLifecycleState({ activeTurns: ACTIVE_TURNS });
    await setStatus('provisioning');
    await markPendingStopObservation(SANDBOX_ID);
    expect(typeof (await readRow()).metadata.pendingStopObservedAtMs).toBe('number');

    await setLifecycleState({ activeTurns: ACTIVE_TURNS });
    await setStatus('stopped');
    await markPendingStopObservation(SANDBOX_ID);
    expect((await readRow()).metadata).not.toHaveProperty('pendingStopObservedAtMs');
  });

  test('a running observation drops the marker and keeps its siblings', async () => {
    await setLifecycleState({ activeTurns: ACTIVE_TURNS, pendingStopObservedAtMs: 1234 });

    await clearPendingStopObservation(SANDBOX_ID);

    const { metadata } = await readRow();
    expect(metadata).not.toHaveProperty('pendingStopObservedAtMs');
    expect(metadata.activeTurns).toEqual(ACTIVE_TURNS);
  });
});
