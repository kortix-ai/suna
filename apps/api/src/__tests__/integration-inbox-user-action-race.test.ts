/**
 * Integration test (real local PostgreSQL): a USER ACTION racing the inbox
 * DRAIN.
 *
 * Two defects share one shape. The user acts on a prompt — removes it, or
 * presses Stop — while the drain is between two statements about the same
 * row. Each test below pins the statement-level fact that makes the user's
 * action win, or makes it lose honestly:
 *
 *  - Stop's hold is ONE statement. A row that moves `running` → `queued`
 *    while the hold runs is still caught by it.
 *  - A held inbox row is never claimed, whatever its `available_at` says.
 *  - A Stop that re-queues a stranded prompt brings it back HELD, so it cannot
 *    wake the box the user just stopped.
 *  - A Remove that reaches a claimed row before its POST deletes it, and the
 *    POST is then refused. A Remove after the POST leaves the row to the
 *    cancel path.
 *  - A runtime copy that could only be EMPTIED is recorded, and the turn-end
 *    sweep deletes it once the loop is idle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  deleteInboxPrompt,
  holdInboxForRequestedStop,
  holdInboxPrompts,
  releaseInboxHold,
  sendJoinsHold,
} from '../projects/session-lifecycle/inbox-rows';
import {
  InboxDeliveryPaused,
  commitInboxPost,
} from '../projects/session-lifecycle/inbox-delivery-hold';
import { requeueStrandedPrompt } from '../projects/session-lifecycle/forwarded-strand-reconcile';
import { requeueAbandonedPrompt } from '../projects/session-lifecycle/redelivery';
import {
  readPendingHusks,
  recordPendingHusks,
  sweepPendingHusks,
} from '../projects/session-lifecycle/husk-cleanup';
import {
  type SessionLifecycleCommandRow,
  claimDueLifecycleCommands,
  enqueueContinueSessionCommand,
  markCommandForwarded,
  requeueForAdmission,
} from '../projects/session-lifecycle/store';
import type { CommandLease } from '../projects/session-lifecycle/command-lease';
import { db } from '../shared/db';

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const WIRE_ID = 'msg_0198f3a1b2c4AbCdEfGhIjKlMn';
const WORKER = 'race-it-worker';

/**
 * Claim `row` the way the drain does and return the lease its writes name.
 * The writes that end a claim apply only to a `running` row under the same
 * `locked_by`; a row a test already claimed keeps its worker.
 */
async function hold(row: { commandId: string }, worker = 'user-action-race-it'): Promise<CommandLease> {
  const result = await db.execute(sql`
    UPDATE kortix.session_lifecycle_commands
       SET status = 'running', locked_by = COALESCE(locked_by, ${worker})
     WHERE command_id = ${row.commandId}::uuid
    RETURNING locked_by`);
  const rows = (Array.isArray(result) ? result : (result as { rows: Array<{ locked_by: string }> }).rows) as Array<{ locked_by: string }>;
  return { commandId: row.commandId, lockedBy: rows[0]?.locked_by ?? worker };
}

async function enqueue(
  clientMessageId: string,
  placement: 'transcript' | 'composer' = 'composer',
): Promise<SessionLifecycleCommandRow> {
  const { row } = await enqueueContinueSessionCommand({
    source: 'ui',
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: null,
    text: 'say hi',
    idempotencyKey: `prompt:${SESSION_ID}:${clientMessageId}`,
    clientMessageId,
    wireMessageId: WIRE_ID,
    placement,
    parts: [{ type: 'text', text: 'say hi' }],
    overrides: { agent: 'build', model: null, variant: null, directory: '/workspace' },
  });
  return row;
}

async function readRow(commandId: string): Promise<Record<string, any> | undefined> {
  const result = await db.execute(sql`
    SELECT status, available_at, payload, result
      FROM kortix.session_lifecycle_commands
     WHERE command_id = ${commandId}::uuid`);
  const rows = ((result as { rows?: Array<Record<string, any>> }).rows ?? result) as Array<
    Record<string, any>
  >;
  return rows[0];
}

async function setStatus(commandId: string, status: 'running' | 'queued') {
  await db.execute(sql`
    UPDATE kortix.session_lifecycle_commands
       SET status = ${status}, locked_by = ${status === 'running' ? WORKER : null}
     WHERE command_id = ${commandId}::uuid`);
}

/**
 * `forwarded_at` is stamped on the API's clock and the Stop on the database's
 * (`now()`). A local Docker database runs a few ms behind the host, so a Stop
 * issued within the same few ms reads as EARLIER than the delivery. A person's
 * Stop comes seconds later; wait past the skew so the order is the real one.
 */
async function stopLaterThanDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function setBox(status: 'active' | 'stopped', metadata: Record<string, unknown> = {}) {
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, metadata)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            ${status}::kortix.session_sandbox_status, ${JSON.stringify(metadata)}::jsonb)
    ON CONFLICT (sandbox_id) DO UPDATE
       SET status = EXCLUDED.status, metadata = EXCLUDED.metadata`);
}

async function cleanup() {
  await db
    .execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'inbox-race-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'inbox-race-it', 'https://example.invalid/r.git')`);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${SANDBOX_ID}`}, 'running')`);
});

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db
    .execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`)
    .catch(() => undefined);
});

describe('Stop holds the queue in one statement', () => {
  test('a row the drain puts back from running to queued WHILE the hold runs is still held', async () => {
    // The drain claims the head Queue List row every scheduler tick, finds the
    // turn still live, and writes it back to `queued` (`requeueForAdmission`).
    // A hold made of three statements — queued, then forwarded, then running —
    // missed a row that moved between the first and the last: it was `running`
    // when the queued arm looked and `queued` when the running arm looked.
    // That row was delivered right after the Stop ended the turn.
    const row = await enqueue('race_hold_head');
    await setStatus(row.commandId, 'running');

    let releaseRequeue!: () => void;
    const requeueMayCommit = new Promise<void>((resolve) => {
      releaseRequeue = resolve;
    });
    let requeueHoldsLock!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      requeueHoldsLock = resolve;
    });
    // The drain's admission refusal, left uncommitted: it holds the row lock
    // while the hold starts, and commits `queued` under it.
    const requeue = db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE kortix.session_lifecycle_commands
           SET status = 'queued', locked_by = NULL,
               available_at = now() + interval '300 milliseconds',
               result = COALESCE(result, '{}'::jsonb) || '{"admission_reason":"turn_active"}'::jsonb
         WHERE command_id = ${row.commandId}::uuid`);
      requeueHoldsLock();
      await requeueMayCommit;
    });
    await lockTaken;

    const hold = holdInboxPrompts(SESSION_ID, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseRequeue();
    await requeue;
    await hold;

    const after = await readRow(row.commandId);
    expect(after?.status).toBe('queued');
    expect(after?.result).toMatchObject({ held: true, admission_reason: 'turn_active' });
    // Not due for the hold horizon: the scheduler cannot claim it.
    expect(new Date(after!.available_at).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  test('a held inbox row is never claimed, even when a requeue made it due', async () => {
    // The running arm marks a claimed row held without moving its clock, and
    // `requeueForAdmission` then gives it a 300 ms backoff. The claim must read
    // `held`, not `available_at`.
    const row = await enqueue('race_held_due');
    await setStatus(row.commandId, 'running');
    await holdInboxPrompts(SESSION_ID, true);
    await requeueForAdmission(await hold(row), 'turn_active', new Date(Date.now() - 1_000));

    const claimed = await claimDueLifecycleCommands({
      workerId: WORKER,
      limit: 5,
      idempotencyKey: row.idempotencyKey!,
    });
    expect(claimed).toHaveLength(0);
    expect((await readRow(row.commandId))?.status).toBe('queued');

    // Released, it is claimable again at once.
    await releaseInboxHold(SESSION_ID);
    const after = await claimDueLifecycleCommands({
      workerId: WORKER,
      limit: 5,
      idempotencyKey: row.idempotencyKey!,
    });
    expect(after.map((r) => r.commandId)).toEqual([row.commandId]);
  });

  test('an automation row the reaper held for a parked box is still claimed at its horizon', async () => {
    // `held` on a row with no `clientMessageId` is the redelivery's "box was
    // parked" marker, and its clock is the only release it has.
    const { row } = await enqueueContinueSessionCommand({
      source: 'trigger:cron',
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      actorUserId: null,
      text: 'scheduled run',
      idempotencyKey: `trigger:${SESSION_ID}:race`,
    });
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = '{"held": true}'::jsonb, available_at = now() - interval '1 second'
       WHERE command_id = ${row.commandId}::uuid`);
    const claimed = await claimDueLifecycleCommands({
      workerId: WORKER,
      limit: 5,
      idempotencyKey: row.idempotencyKey!,
    });
    expect(claimed.map((r) => r.commandId)).toEqual([row.commandId]);
  });

  test('a client Stop holds the queue on the server, before the abort is forwarded', async () => {
    const queued = await enqueue('race_stop_queued');
    const running = await enqueue('race_stop_running');
    await setStatus(running.commandId, 'running');

    expect(await holdInboxForRequestedStop(SESSION_ID)).toBe(2);
    expect((await readRow(queued.commandId))?.result).toMatchObject({ held: true });
    expect((await readRow(running.commandId))?.payload).toMatchObject({
      stopPausedOnDelivery: true,
    });
  });
});

describe('a send made BEFORE Stop whose POST lands AFTER it', () => {
  // Live, 2026-09-23 (Q7, 1 of 5 runs): three Queue List rows were typed, then
  // Stop was pressed. The browser dispatched the second and third POSTs after
  // the Stop (queued behind the first), and each POST released the session
  // hold — "any new send releases the hold" — so the head row was delivered
  // the moment the Stop ended the turn. The send is ordered against the Stop
  // on ONE clock: the browser's Enter instant against the browser's Stop
  // instant, both carried in the requests.
  const T = Date.now();

  test('joins the hold when the Enter instant precedes the Stop instant', async () => {
    await setBox('active');
    await holdInboxForRequestedStop(SESSION_ID, { clientStoppedAtMs: T });
    expect(await sendJoinsHold(SESSION_ID, T - 1_000)).toBe(true);
    expect(await sendJoinsHold(SESSION_ID, T + 1_000)).toBe(false);
  });

  test('a send with no Enter instant, or a hold with no client instant, keeps the old rule', async () => {
    await setBox('active');
    await holdInboxForRequestedStop(SESSION_ID);
    expect(await sendJoinsHold(SESSION_ID, T - 1_000)).toBe(false);
    await holdInboxForRequestedStop(SESSION_ID, { clientStoppedAtMs: T });
    expect(await sendJoinsHold(SESSION_ID, null)).toBe(false);
  });

  test('the server’s own hold for the same Stop keeps the client instant', async () => {
    await setBox('active');
    await holdInboxForRequestedStop(SESSION_ID, { clientStoppedAtMs: T });
    await holdInboxForRequestedStop(SESSION_ID);
    expect(await sendJoinsHold(SESSION_ID, T - 1_000)).toBe(true);
  });

  test('a released hold is over: nothing joins it, and repairs deliver again', async () => {
    await setBox('active');
    const row = await enqueue('race_after_release', 'transcript');
    await setStatus(row.commandId, 'running');
    await markCommandForwarded(await hold(row), SESSION_ID, WIRE_ID);
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = result || '{"status":"delivered"}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);
    await holdInboxForRequestedStop(SESSION_ID, { clientStoppedAtMs: T });
    await releaseInboxHold(SESSION_ID);

    expect(await sendJoinsHold(SESSION_ID, T - 1_000)).toBe(false);
    expect(await requeueStrandedPrompt(SESSION_ID, WIRE_ID)).toBe('requeued');
    expect((await readRow(row.commandId))?.result).not.toHaveProperty('held');
  });
});

describe('a stopped session is never woken by a requeue', () => {
  test('a stranded steer the Stop paused comes back HELD, not due', async () => {
    const row = await enqueue('race_strand_stop_paused', 'transcript');
    await setStatus(row.commandId, 'running');
    await markCommandForwarded(await hold(row), SESSION_ID, WIRE_ID);
    await holdInboxPrompts(SESSION_ID, true);
    await setBox('active');

    expect(await requeueStrandedPrompt(SESSION_ID, WIRE_ID)).toBe('requeued');
    const after = await readRow(row.commandId);
    expect(after?.status).toBe('queued');
    expect(after?.result).toMatchObject({ held: true, redelivered_from: 'stranded_placement' });
    expect(new Date(after!.available_at).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  test('a stranded steer of a box that is no longer running comes back HELD', async () => {
    // POST .../stop aborts the turn and powers the box off; the turn-end relay
    // reconciles after that. A due-now requeue there is what re-woke a stopped
    // session minutes later.
    const row = await enqueue('race_strand_stopped_box', 'transcript');
    await setStatus(row.commandId, 'running');
    await markCommandForwarded(await hold(row), SESSION_ID, WIRE_ID);
    await setBox('stopped');

    expect(await requeueStrandedPrompt(SESSION_ID, WIRE_ID)).toBe('requeued');
    expect((await readRow(row.commandId))?.result).toMatchObject({ held: true });
  });

  test('a steer ACCEPTED before the Stop (result delivered, never read) comes back HELD', async () => {
    // The acceptance relay closes a steer `delivered` on persistence, long
    // before a step reads it, so the Stop's hold does not mark it — and the
    // turn the Stop ended then finds it stranded. The stop mark is what says
    // a person stopped the session after this prompt went out.
    const row = await enqueue('race_strand_delivered', 'transcript');
    await setStatus(row.commandId, 'running');
    await markCommandForwarded(await hold(row), SESSION_ID, WIRE_ID);
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = result || '{"status":"delivered"}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);
    await setBox('active');
    await stopLaterThanDelivery();
    await holdInboxForRequestedStop(SESSION_ID);

    expect(await requeueStrandedPrompt(SESSION_ID, WIRE_ID)).toBe('requeued');
    expect((await readRow(row.commandId))?.result).toMatchObject({ held: true });
  });

  test('the reaper hands back an accepted steer HELD when a person stopped after it went out', async () => {
    const row = await enqueue('race_reaper_delivered', 'transcript');
    await setStatus(row.commandId, 'running');
    await markCommandForwarded(await hold(row), SESSION_ID, WIRE_ID);
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = result || '{"status":"delivered"}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);
    await setBox('active');
    await stopLaterThanDelivery();
    await holdInboxForRequestedStop(SESSION_ID);

    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: WIRE_ID,
        turnToken: 'turn-race',
        endReason: 'abandoned',
      }),
    ).toBe('requeued');
    expect((await readRow(row.commandId))?.result).toMatchObject({ held: true });
  });

  test('a prompt that went out AFTER the Stop is not held by it', async () => {
    await setBox('active');
    await holdInboxForRequestedStop(SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const row = await enqueue('race_after_stop', 'transcript');
    await setStatus(row.commandId, 'running');
    await markCommandForwarded(await hold(row), SESSION_ID, WIRE_ID);

    expect(await requeueStrandedPrompt(SESSION_ID, WIRE_ID)).toBe('requeued');
    expect((await readRow(row.commandId))?.result).not.toHaveProperty('held');
  });

  test('a stranded steer of a live, unstopped session still comes back due', async () => {
    const row = await enqueue('race_strand_live', 'transcript');
    await setStatus(row.commandId, 'running');
    await markCommandForwarded(await hold(row), SESSION_ID, WIRE_ID);
    await setBox('active');

    expect(await requeueStrandedPrompt(SESSION_ID, WIRE_ID)).toBe('requeued');
    const after = await readRow(row.commandId);
    expect(after?.result).not.toHaveProperty('held');
    expect(new Date(after!.available_at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe('Remove against a claimed row', () => {
  test('a Remove that reaches the row before its POST wins, and the POST is refused', async () => {
    const row = await enqueue('race_remove_first', 'transcript');
    await setStatus(row.commandId, 'running');

    const removed = await deleteInboxPrompt(SESSION_ID, row.commandId);
    expect(removed.outcome).toBe('deleted');
    await expect(commitInboxPost(row.commandId)).rejects.toBeInstanceOf(InboxDeliveryPaused);
    expect(await readRow(row.commandId)).toBeUndefined();
  });

  test('a Remove after the POST is committed leaves the row to the cancel path', async () => {
    const row = await enqueue('race_post_first', 'transcript');
    await setStatus(row.commandId, 'running');

    await commitInboxPost(row.commandId);
    const removed = await deleteInboxPrompt(SESSION_ID, row.commandId);
    expect(removed.outcome).toBe('delivering');
    expect((await readRow(row.commandId))?.status).toBe('running');
  });

  test('the commit refuses a row Stop held while it was claimed', async () => {
    const row = await enqueue('race_commit_held');
    await setStatus(row.commandId, 'running');
    await holdInboxPrompts(SESSION_ID, true);
    await expect(commitInboxPost(row.commandId)).rejects.toBeInstanceOf(InboxDeliveryPaused);
  });

  test('a new claim clears the previous attempt’s commit, so the next Remove can win again', async () => {
    const row = await enqueue('race_recommit');
    await setStatus(row.commandId, 'running');
    await commitInboxPost(row.commandId);
    await requeueForAdmission(await hold(row), 'turn_active', new Date(Date.now() - 1_000));

    const [claimed] = await claimDueLifecycleCommands({
      workerId: WORKER,
      limit: 5,
      idempotencyKey: row.idempotencyKey!,
    });
    expect(claimed?.commandId).toBe(row.commandId);
    expect((await deleteInboxPrompt(SESSION_ID, row.commandId)).outcome).toBe('deleted');
  });
});

describe('an emptied runtime copy is deleted once the loop is idle', () => {
  test('the husk is recorded, kept while the runtime refuses, and cleared once deleted', async () => {
    await setBox('active', { unrelated: 'kept' });
    const husk = 'msg_0198f3a1b2c5HuskHuskHusk01';
    await recordPendingHusks(SESSION_ID, [husk]);
    await recordPendingHusks(SESSION_ID, [husk]);
    expect(await readPendingHusks(SESSION_ID)).toEqual([husk]);

    const attempts: string[] = [];
    const busy = await sweepPendingHusks(SESSION_ID, {
      deleteMessage: async (_sid, id) => {
        attempts.push(id);
        return 'busy';
      },
    });
    expect(busy).toEqual({ deleted: 0, pending: 1 });
    expect(await readPendingHusks(SESSION_ID)).toEqual([husk]);

    const idle = await sweepPendingHusks(SESSION_ID, {
      deleteMessage: async (_sid, id) => {
        attempts.push(id);
        return 'deleted';
      },
    });
    expect(idle).toEqual({ deleted: 1, pending: 0 });
    expect(await readPendingHusks(SESSION_ID)).toEqual([]);
    expect(attempts).toEqual([husk, husk]);

    const box = await db.execute(sql`
      SELECT metadata FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
    const rows = ((box as { rows?: Array<Record<string, any>> }).rows ?? box) as Array<
      Record<string, any>
    >;
    expect(rows[0]?.metadata).toMatchObject({ unrelated: 'kept' });
  });
});
