/**
 * Integration test (real local PostgreSQL): two ways a queued prompt can get
 * stuck between the inbox and the sandbox.
 *
 *  1. STOP DURING DELIVERY. Stop marks a CLAIMED row `held`. The delivery then
 *     sees the hold and gives the row back, due now. The drain must not claim
 *     a held inbox row, or it claims it again on every tick, for ever.
 *  2. A POD THAT EXITS MID-DELIVERY. A rollout's SIGTERM ends the process while
 *     a drain holds a row `running`. Nothing else may claim that row until its
 *     lock and the reclaim grace expire, and the session's next prompt waits
 *     behind it the whole time — unless the shutdown hands the row back.
 *
 * The drain runs for real here: claim, admission, `continueSession`, and the
 * pause check, against a stopped session with no sandbox. Nothing is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { executeQueuedContinue } from '../projects/session-lifecycle/queued-continue';
import { holdInboxPrompts } from '../projects/session-lifecycle/inbox-rows';
import { admitInboxPrompt } from '../projects/session-lifecycle/inbox-admission';
import { handBackClaims, trackClaims } from '../projects/session-lifecycle/claim-handover';
import {
  InboxDeliveryPaused,
  assertInboxDeliveryActive,
} from '../projects/session-lifecycle/inbox-delivery-hold';
import { LIFECYCLE_CLAIM_LOCK_MS } from '../projects/session-lifecycle/command-lease';
import {
  LIFECYCLE_RUNNING_RECLAIM_GRACE_MS,
  claimDueLifecycleCommands,
  enqueueContinueSessionCommand,
  type SessionLifecycleCommandRow,
} from '../projects/session-lifecycle/store';
import { db } from '../shared/db';

const SESSION_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();

async function enqueue(clientMessageId: string): Promise<SessionLifecycleCommandRow> {
  const { row } = await enqueueContinueSessionCommand({
    source: 'ui',
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: USER_ID,
    text: 'say hi',
    idempotencyKey: `prompt:${SESSION_ID}:${clientMessageId}`,
    clientMessageId,
    parts: [{ type: 'text', text: 'say hi' }],
  });
  return row;
}

async function claimOne(workerId: string, now?: Date): Promise<SessionLifecycleCommandRow[]> {
  return claimDueLifecycleCommands({ workerId, limit: 10, ...(now ? { now } : {}) });
}

async function readRow(commandId: string) {
  const result = await db.execute(sql`
    SELECT status, attempts, result, available_at, locked_by
      FROM kortix.session_lifecycle_commands
     WHERE command_id = ${commandId}::uuid`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{
    status: string;
    attempts: number;
    result: Record<string, unknown>;
    available_at: Date | string;
    locked_by: string | null;
  }>;
  return rows[0];
}

async function sessionStatus(): Promise<string> {
  const result = await db.execute(sql`
    SELECT status FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{ status: string }>;
  return rows[0].status;
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'inbox-pause-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'inbox-pause-it', 'https://example.invalid/r.git')`);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, 'br-inbox-pause-it', 'stopped')`);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`
    UPDATE kortix.project_sessions SET status = 'stopped' WHERE session_id = ${SESSION_ID}`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`);
});

describe('Stop pressed while a prompt is being delivered', () => {
  test('the paused prompt stays out of the drain until the hold is lifted', async () => {
    const row = await enqueue('q_stop_mid_delivery');
    const [claimed] = await claimOne('drain-a');
    expect(claimed.commandId).toBe(row.commandId);

    // The user presses Stop while the drain holds the row (e.g. a cold box).
    expect(await holdInboxPrompts(SESSION_ID, true)).toBe(1);

    // The delivery sees the hold and gives the row back.
    expect(await executeQueuedContinue(claimed)).toBe('queued');
    const after = await readRow(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.result.held).toBe(true);

    // The next drain tick must not take it again.
    expect(await claimOne('drain-b')).toEqual([]);
  });

  test('the paused delivery leaves the session status as it found it', async () => {
    await enqueue('q_stop_keeps_status');
    const [claimed] = await claimOne('drain-a');
    await holdInboxPrompts(SESSION_ID, true);

    await executeQueuedContinue(claimed);

    // No box was woken, so the session must not read `running`.
    expect(await sessionStatus()).toBe('stopped');
  });

  test('a held prompt past its 24 h due time is still not claimed', async () => {
    const row = await enqueue('q_hold_expired');
    await holdInboxPrompts(SESSION_ID, true);
    // 24 h later: the due time passed and no one lifted the hold.
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET available_at = now() - interval '1 second'
       WHERE command_id = ${row.commandId}::uuid`);

    expect(await claimOne('drain-a')).toEqual([]);
    expect((await readRow(row.commandId)).result.held).toBe(true);
  });

  test('a held AUTOMATION row is still delivered when its due time passes', async () => {
    const { row } = await enqueueContinueSessionCommand({
      source: 'trigger:cron',
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      actorUserId: USER_ID,
      text: 'scheduled run',
      idempotencyKey: `trigger:${SESSION_ID}:held`,
      held: true,
      availableAt: new Date(Date.now() - 1_000),
    });

    const claimed = await claimOne('drain-a');
    expect(claimed.map((r) => r.commandId)).toEqual([row.commandId]);
  });
});

describe('a pod that exits while it delivers a prompt', () => {
  test('its claimed prompt is released at once, not after the lock and grace', async () => {
    const first = await enqueue('q_pod_exit_first');
    const t0 = new Date();
    const [claimed] = await claimOne('pod-a', t0);
    expect(claimed.commandId).toBe(first.commandId);
    // pod-a's drain recorded the claim; SIGTERM arrives mid-delivery.
    trackClaims([claimed]);
    expect(await handBackClaims(0)).toBe(1);
    const handedBack = await readRow(first.commandId);
    expect(handedBack.status).toBe('queued');
    expect(handedBack.locked_by).toBeNull();
    // The claim's attempt is given back: a rollout does not spend the budget.
    expect(handedBack.attempts).toBe(0);

    // The user sends the next message. It waits for the FIRST in send order,
    // not for a claim no live process holds.
    const second = await enqueue('q_pod_exit_second');
    expect(await admitInboxPrompt(second)).toMatchObject({ admit: false, reason: 'older_prompt_pending' });

    // The next pod claims the first prompt one minute later, not ten, and
    // admits it: nothing is in flight any more.
    const t1 = new Date(t0.getTime() + 60_000);
    const [again] = await claimDueLifecycleCommands({
      workerId: 'pod-b', limit: 1, now: t1, idempotencyKey: first.idempotencyKey!,
    });
    expect(again?.commandId).toBe(first.commandId);
    expect(await admitInboxPrompt(again!)).toEqual({ admit: true });
  });

  test('a delivery still running in the exiting pod does not send after the hand-back', async () => {
    await enqueue('q_pod_exit_late_send');
    const [claimed] = await claimOne('pod-a');
    trackClaims([claimed]);
    await handBackClaims(0);

    await expect(assertInboxDeliveryActive(claimed)).rejects.toBeInstanceOf(InboxDeliveryPaused);
  });

  test('a placement repair may still re-send after its own forward closed the claim', async () => {
    const row = await enqueue('q_repair_resend');
    const [claimed] = await claimOne('drain-a');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'succeeded', locked_by = NULL, locked_until = NULL,
             result = '{"status": "forwarded"}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);

    await expect(assertInboxDeliveryActive(claimed)).resolves.toBeUndefined();
  });

  test('a pod killed without a shutdown is reclaimed after the 5-min lock plus the 5-min grace', async () => {
    const row = await enqueue('q_pod_exit_window');
    const t0 = new Date();
    await claimOne('pod-a', t0);
    const at = (ms: number) => new Date(t0.getTime() + ms);

    expect(await claimOne('pod-b', at(LIFECYCLE_CLAIM_LOCK_MS + 1_000))).toEqual([]);
    expect(
      await claimOne('pod-b', at(LIFECYCLE_CLAIM_LOCK_MS + LIFECYCLE_RUNNING_RECLAIM_GRACE_MS - 1_000)),
    ).toEqual([]);
    const late = await claimOne('pod-b', at(LIFECYCLE_CLAIM_LOCK_MS + LIFECYCLE_RUNNING_RECLAIM_GRACE_MS + 1_000));
    expect(late.map((r) => r.commandId)).toEqual([row.commandId]);
  });
});
