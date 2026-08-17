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
  beginSandboxTurn,
  clearSandboxTurn,
  completeSandboxTurn,
} from '../projects/sandbox-turn-lifecycle';
import { db } from '../shared/db';

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `turn-lifecycle-${SANDBOX_ID}`;
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();

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
});

afterAll(async () => {
  await db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
});

describe('per-turn terminal isolation', () => {
  test('a terminal identified turn leaves a concurrent turn and its deadline intact', async () => {
    await setLifecycleState({
      activeTurns: {
        first: {
          token: 'first',
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_first',
          startedAtMs: 1,
        },
        second: {
          token: 'second',
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
      second: {
        token: 'second',
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
        only: {
          token: 'only',
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
        only: {
          token: 'only',
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_only',
          startedAtMs: 1,
        },
      },
    });

    expect(await clearSandboxTurn(SANDBOX_ID, 'only', 60_000)).toBe(true);

    const after = await readRow();
    expect(after.metadata.activeTurns).toEqual({});
    expect(deadlineMs(after)).toBeLessThanOrEqual(Date.now() + 60_500);
  });

  test('a stale identified terminal event cannot remove a newer identified turn', async () => {
    await setLifecycleState({
      activeTurns: {
        newer: {
          token: 'newer',
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
        command: {
          token: 'command',
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: null,
          startedAtMs: 1,
        },
        exact: {
          token: 'exact',
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
      command: {
        token: 'command',
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
        older: {
          token: 'older',
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: null,
          startedAtMs: 1,
        },
        newer: {
          token: 'newer',
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
      newer: {
        token: 'newer',
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
        older: {
          token: 'older',
          state: 'active',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_older',
          startedAtMs: 1,
        },
        newer: {
          token: 'newer',
          state: 'delivering',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_newer',
          startedAtMs: 2,
        },
      },
    });

    expect(await abandonSandboxTurn({ sandboxId: SANDBOX_ID }, 'newer')).toBe(true);

    expect((await readRow()).metadata.activeTurns).toEqual({
      older: {
        token: 'older',
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
        first: {
          token: 'first',
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
               'second',
               jsonb_build_object(
                 'token', 'second',
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

    const cleanup = clearSandboxTurn(SANDBOX_ID, 'first', 60_000);
    await Bun.sleep(50);
    releaseWriter();
    await Promise.all([writer, cleanup]);

    expect((await readRow()).metadata.activeTurns).toEqual({
      second: {
        token: 'second',
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
        first: {
          token: 'first',
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
               'second',
               jsonb_build_object(
                 'token', 'second',
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
      second: {
        token: 'second',
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
        { token: 'at-cap', opencodeSessionId: 'ses_root', messageId: 'msg_at_cap' },
        60_000,
        observedAtMs,
      ),
    ).toBe('granted');
    const row = await readRow();
    expect(row.metadata.activeTurns).toHaveProperty('at-cap');
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
        { token: 'normalized', opencodeSessionId: 'ses_root', messageId: 'msg_normalized' },
        60_000,
      ),
    ).toBe('granted');
    expect((await readRow()).metadata.activeTurns).toHaveProperty('normalized');
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
        { token: 'prompt-first', opencodeSessionId: 'ses_root', messageId: 'msg_first' },
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
        { token: 'prompt-second', opencodeSessionId: 'ses_root', messageId: 'msg_second' },
        60_000,
      ),
    ).toBe('no_box');
    expect((await readRow()).metadata.activeTurns).toBeUndefined();
  });

  test('an expired stop claim is recoverable by a new prompt', async () => {
    await setLifecycleState({
      lifecycleStopClaim: {
        token: 'expired-stop',
        claimedAtMs: Date.now() - sandboxStopClaimLeaseMs() - 1,
      },
    });

    expect(
      await beginSandboxTurn(
        { sandboxId: SANDBOX_ID },
        { token: 'recovery', opencodeSessionId: 'ses_root', messageId: 'msg_recovery' },
        60_000,
      ),
    ).toBe('granted');
    const metadata = (await readRow()).metadata;
    expect(metadata.lifecycleStopClaim).toBeUndefined();
    expect(metadata.activeTurns).toHaveProperty('recovery');
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
          active: {
            token: 'active',
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
