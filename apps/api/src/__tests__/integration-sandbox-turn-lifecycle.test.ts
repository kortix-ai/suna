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
import { sandboxStopClaimLeaseMs } from '../projects/sandbox-deadline-policy';
import {
  abandonSandboxTurn,
  acceptSandboxTurn,
  beginSandboxTurn,
  clearSandboxTurn,
  completeSandboxTurn,
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

    await completeSandboxTurn(SESSION_ID, 'idle', {
      opencodeSessionId: 'ses_root',
      messageId: 'msg_old',
    });

    const after = await readRow();
    expect(after.metadata.activeTurns).toEqual(before.metadata.activeTurns);
    expect(deadlineMs(after)).toBe(deadlineMs(before));
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
    ).toBe(true);

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
      // A failure with no reported text still says SOMETHING. "Nothing
      // happened" must never be the whole record of a turn that failed.
      error: { name: 'TurnFailed' },
    });
  });

  test('a relayed session.error is stored verbatim on the row', async () => {
    // THE INCIDENT THIS COLUMN EXISTS FOR. `end_reason` is a five-value enum;
    // it cannot say WHICH model was missing. OpenCode raises session.error
    // before any assistant message exists and persists nothing for the turn but
    // the user message, so the relay is the only carrier of this text and the
    // row is the only place it can live.
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-error'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_error' },
      60_000,
    );

    await completeSandboxTurn(
      SESSION_ID,
      'error',
      { opencodeSessionId: 'ses_root', messageId: 'msg_ledger_error' },
      {
        name: 'ModelNotFound',
        message: 'Model kortix/grok-4.6 not found',
        statusCode: 404,
        isRetryable: false,
        providerID: 'kortix',
      },
      60_000,
    );

    const turn = await readTurn(t('ledger-error'));
    expect(turn?.end_reason).toBe('failed');
    expect(turn?.error).toMatchObject({
      name: 'ModelNotFound',
      message: 'Model kortix/grok-4.6 not found',
      status_code: 404,
      is_retryable: false,
      provider_id: 'kortix',
    });
    // Recorded by the control plane, so it is an instant a reader can trust.
    expect(
      Date.parse(String((turn?.error as Record<string, unknown>).recorded_at)),
    ).toBeGreaterThan(0);
  });

  test('a RETRYABLE error is not terminal and writes nothing', async () => {
    // A 429 backoff fires session.error while the turn keeps running. Storing
    // an error there would show the user a failure for a turn that then
    // succeeded.
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-retry'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_retry' },
      60_000,
    );

    expect(
      await completeSandboxTurn(
        SESSION_ID,
        'error',
        { opencodeSessionId: 'ses_root', messageId: 'msg_ledger_retry' },
        { name: 'RateLimited', message: 'slow down', statusCode: 429, isRetryable: true },
        60_000,
      ),
    ).toBe(false);
    expect(await readTurn(t('ledger-retry'))).toMatchObject({ state: 'delivering', error: null });
  });

  test('an idle end stores no error at all', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-idle'), opencodeSessionId: 'ses_root', messageId: 'msg_ledger_idle' },
      60_000,
    );

    await completeSandboxTurn(
      SESSION_ID,
      'idle',
      { opencodeSessionId: 'ses_root', messageId: 'msg_ledger_idle' },
      undefined,
      60_000,
    );

    expect(await readTurn(t('ledger-idle'))).toMatchObject({
      end_reason: 'completed',
      error: null,
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
      error: { name: 'RuntimeGone' },
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
    // unreachable, r4.ts turn_abandoned). Leaving the row 'delivering' makes
    // the ledger claim a turn is running for ever.
    expect((await readRow()).metadata.activeTurns).toEqual({});
    expect(await readTurn(t('ledger-abandon'))).toMatchObject({
      state: 'ended',
      end_reason: 'abandoned',
      opencode_session_id: 'ses_root',
      message_id: 'msg_ledger_abandon',
      // The prompt the runtime never took is exactly the case a user reads as
      // "nothing happened". It gets a sentence too.
      error: { name: 'TurnAbandoned', message: 'The runtime did not accept this prompt.' },
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
    ).toBe(true);

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
    ).toBe(true);

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

  test('the stop writer settles every open row of the sandbox and nothing else', async () => {
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-stop-open'), opencodeSessionId: 'ses_root', messageId: 'msg_stop_open' },
      60_000,
    );
    await beginSandboxTurn(
      { sandboxId: SANDBOX_ID },
      { token: t('ledger-stop-done'), opencodeSessionId: 'ses_root', messageId: 'msg_stop_done' },
      60_000,
    );
    await completeSandboxTurn(
      SESSION_ID,
      'idle',
      { opencodeSessionId: 'ses_root', messageId: 'msg_stop_done' },
      undefined,
      60_000,
    );

    // The statement applyStoppedState runs inside its stop transaction, right
    // after the one that erases activeTurn/activeTurns.
    await db.execute(settleOpenSandboxTurnsQuery(SANDBOX_ID, 'runtime_gone'));

    expect(await readTurn(t('ledger-stop-open'))).toMatchObject({
      state: 'ended',
      end_reason: 'runtime_gone',
      // A turn the stop swept up ended because the runtime went away. Saying
      // so is what stops it reading as an empty success.
      error: { name: 'RuntimeGone' },
    });
    // An already-settled row keeps the reason it ended with.
    expect(await readTurn(t('ledger-stop-done'))).toMatchObject({
      state: 'ended',
      end_reason: 'completed',
      error: null,
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
    // partial index is USABLE for this exact predicate, not that it is chosen
    // today: a predicate the index cannot serve stays a seq scan even here.
    const text = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const plan = await tx.execute(sql`
        EXPLAIN UPDATE kortix.session_turns
                   SET state = 'ended'
                 WHERE sandbox_id = ${SANDBOX_ID}::uuid
                   AND state <> 'ended'`);
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
