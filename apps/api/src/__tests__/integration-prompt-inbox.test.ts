/**
 * Integration test (real local PostgreSQL): the prompt inbox's DURABLE half.
 *
 * The unit tests beside each module inject their reads and writes, so none of
 * their SQL ever executes. Everything here depends on Postgres actually doing
 * what the statement says: a `GREATEST(attempts - 1, 0)` that floors, a jsonb
 * merge that keeps the sibling keys, an admission gate that reads the same
 * authority `GET .../turn` serves from, and a redelivery whose `status =
 * 'succeeded'` predicate is what stops two reaper passes requeueing one prompt
 * twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  INBOX_ORDER_BACKOFF_MS,
  INBOX_TURN_ACTIVE_BACKOFF_MS,
  admitInboxPrompt,
  sessionHoldsTurnAuthority,
} from '../projects/session-lifecycle/inbox-admission';
import {
  deleteInboxPrompt,
  holdInboxPrompts,
  listInboxPrompts,
  retryInboxPrompt,
} from '../projects/session-lifecycle/inbox-rows';
import { requeueAbandonedPrompt } from '../projects/session-lifecycle/redelivery';
import {
  LIFECYCLE_RUNNING_RECLAIM_GRACE_MS,
  type SessionLifecycleCommandRow,
  claimDueLifecycleCommands,
  enqueueContinueSessionCommand,
  markCommandFailed,
  requeueForAdmission,
} from '../projects/session-lifecycle/store';
import { db } from '../shared/db';

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const WIRE_ID = 'msg_0198f3a1b2c4AbCdEfGhIjKlMn';

async function enqueue(
  clientMessageId: string,
  overrides: { wireMessageId?: string; createdAt?: string } = {},
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
    wireMessageId: overrides.wireMessageId ?? WIRE_ID,
    parts: [{ type: 'text', text: 'say hi' }],
    overrides: { agent: 'build', model: null, variant: null, directory: '/workspace' },
  });
  if (overrides.createdAt) {
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET created_at = ${overrides.createdAt}::timestamptz
       WHERE command_id = ${row.commandId}::uuid`);
  }
  return row;
}

async function readRow(commandId: string): Promise<Record<string, unknown>> {
  const result = await db.execute(sql`
    SELECT status, attempts, payload, result, last_error, locked_by
      FROM kortix.session_lifecycle_commands
     WHERE command_id = ${commandId}::uuid`);
  const rows = ((result as { rows?: Array<Record<string, unknown>> }).rows ??
    result) as Array<Record<string, unknown>>;
  return rows[0];
}

async function setBox(status: 'active' | 'stopped', activeTurns: Record<string, unknown>) {
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, metadata)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            ${status}::kortix.session_sandbox_status,
            ${JSON.stringify({ activeTurns })}::jsonb)
    ON CONFLICT (sandbox_id) DO UPDATE
       SET status = EXCLUDED.status, metadata = EXCLUDED.metadata`);
}

async function cleanup() {
  await db
    .execute(
      sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`,
    )
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'prompt-inbox-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'prompt-inbox-it', 'https://example.invalid/r.git')`);
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

describe('the inbox row', () => {
  test('carries the client-minted wire id and the full body into the payload', async () => {
    const row = await enqueue('q_1');
    const stored = (await readRow(row.commandId)).payload as Record<string, unknown>;
    expect(stored.clientMessageId).toBe('q_1');
    expect(stored.wireMessageId).toBe(WIRE_ID);
    expect(stored.parts).toEqual([{ type: 'text', text: 'say hi' }]);
    // The legacy text field stays populated: the title generator and every
    // pre-inbox reader still read it.
    expect(stored.text).toBe('say hi');
  });

  test('the SAME client_message_id is one row, enforced by the unique index', async () => {
    const first = await enqueue('q_dupe');
    const second = await enqueueContinueSessionCommand({
      source: 'ui',
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      actorUserId: null,
      text: 'say hi again',
      idempotencyKey: `prompt:${SESSION_ID}:q_dupe`,
      clientMessageId: 'q_dupe',
      wireMessageId: WIRE_ID,
      parts: [{ type: 'text', text: 'say hi again' }],
    });
    expect(second.deduped).toBe(true);
    expect(second.row.commandId).toBe(first.commandId);
    // And nothing was overwritten: the first submission still owns the row.
    expect((second.row.payload as Record<string, unknown>).text).toBe('say hi');
  });
});

describe('requeueForAdmission against real Postgres', () => {
  test('gives the claim back and stamps WHY the prompt is waiting', async () => {
    const row = await enqueue('q_wait');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running', attempts = 3, locked_by = 'worker-1'
       WHERE command_id = ${row.commandId}::uuid`);

    await requeueForAdmission(row.commandId, 'turn_active', new Date(Date.now() + 2_000));

    const after = await readRow(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(2);
    expect(after.locked_by).toBeNull();
    expect(after.result).toEqual({ admission_reason: 'turn_active', admission_refusals: 1 });
    // The refusal must not touch the prompt itself.
    expect((after.payload as Record<string, unknown>).wireMessageId).toBe(WIRE_ID);
    // But it DOES record that the row did not go out on its first claim. This
    // marker is in the payload rather than in `result` because `result` is
    // replaced wholesale by "send now" — see `retryInboxPrompt`.
    expect((after.payload as Record<string, unknown>).remintOnDelivery).toBe(true);
  });

  test('the refusal COUNT grows, which is what makes the backoff grow', async () => {
    // A waiting prompt re-claims a slot from the shared lifecycle drain budget
    // on every refusal. `admissionBackoffMs` reads this counter to widen the
    // gap so a long turn costs a handful of claims instead of one per second.
    const row = await enqueue('q_refusals');
    await requeueForAdmission(row.commandId, 'turn_active', new Date());
    await requeueForAdmission(row.commandId, 'turn_active', new Date());
    await requeueForAdmission(row.commandId, 'turn_active', new Date());
    expect((await readRow(row.commandId)).result).toEqual({
      admission_reason: 'turn_active',
      admission_refusals: 3,
    });
  });

  test('"send now" clears the display marker and KEEPS the durable one', async () => {
    // The two markers exist separately for exactly this moment: the row must
    // stop reading `waiting`, and the drain must still know the client's wire
    // id has been overtaken. Collapsing them delivered the stale id, which
    // OpenCode reads as already answered — the prompt is accepted and silently
    // never runs.
    const row = await enqueue('q_promote_marker');
    await requeueForAdmission(row.commandId, 'turn_active', new Date());
    const promoted = await retryInboxPrompt(SESSION_ID, row.commandId);
    expect(promoted).not.toBeNull();

    const after = await readRow(row.commandId);
    expect(after.result).toEqual({ promoted: true });
    expect((after.payload as Record<string, unknown>).remintOnDelivery).toBe(true);
    expect((after.payload as Record<string, unknown>).wireMessageId).toBe(WIRE_ID);
  });

  test('the attempt give-back FLOORS at zero', async () => {
    // A concurrent writer can already have reset `attempts`; `GREATEST(...,0)`
    // is what stops a negative count, which the dead-letter budget compares on.
    const row = await enqueue('q_floor');
    await requeueForAdmission(row.commandId, 'older_prompt_pending', new Date());
    expect((await readRow(row.commandId)).attempts).toBe(0);
  });

  test('the marker MERGES into result rather than replacing it', async () => {
    const row = await enqueue('q_merge');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = '{"kept": true}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);
    await requeueForAdmission(row.commandId, 'turn_active', new Date());
    expect((await readRow(row.commandId)).result).toEqual({
      kept: true,
      admission_reason: 'turn_active',
      admission_refusals: 1,
    });
  });
});

describe('admitInboxPrompt against real rows', () => {
  const turn = {
    'turn-1': {
      token: 'turn-1',
      state: 'active',
      opencodeSessionId: 'ses_root',
      messageId: WIRE_ID,
      startedAtMs: 1,
    },
  };

  test('a live turn on a RUNNING box refuses admission', async () => {
    const row = await enqueue('q_admit');
    await setBox('active', turn);
    expect(await admitInboxPrompt(row)).toEqual({
      admit: false,
      reason: 'turn_active',
      retryAfterMs: INBOX_TURN_ACTIVE_BACKOFF_MS,
    });
  });

  test('the SAME metadata on a STOPPED box admits — authority dies with the runtime', async () => {
    const row = await enqueue('q_admit_stopped');
    await setBox('stopped', turn);
    expect(await admitInboxPrompt(row)).toEqual({ admit: true });
    // And the shared predicate agrees, which is what keeps `GET .../turn` and
    // this gate from ever disagreeing about "is this session busy".
    const box = await db.execute(sql`
      SELECT status, metadata FROM kortix.session_sandboxes
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
    const rows = ((box as { rows?: Array<Record<string, unknown>> }).rows ?? box) as Array<
      Record<string, unknown>
    >;
    expect(
      sessionHoldsTurnAuthority({
        status: rows[0].status as string,
        metadata: rows[0].metadata as Record<string, unknown>,
      }),
    ).toBe(false);
  });

  test('an OLDER pending prompt of the same session holds the younger one back', async () => {
    await enqueue('q_old', { createdAt: '2026-08-01T00:00:00.000Z' });
    const younger = await enqueue('q_young', { createdAt: '2026-08-02T00:00:00.000Z' });
    await setBox('stopped', {});

    expect(await admitInboxPrompt(younger)).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('a promoted row still waits for a sibling ALREADY CLAIMED', async () => {
    // `promoted` yields the queue-ORDER rule, not the one-at-a-time rule. A
    // sibling in `running` is inside `continueSession`, which waits up to five
    // minutes for a cold box — the whole of that time with no turn authority
    // for the turn-active gate above to see. Admitting here puts two prompts of
    // one session on the wire, and the second aborts the turn the first starts.
    const inFlight = await enqueue('q_inflight', { createdAt: '2026-08-01T00:00:00.000Z' });
    const promoted = await enqueue('q_promoted', { createdAt: '2026-08-02T00:00:00.000Z' });
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${inFlight.commandId}::uuid`);
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = '{"promoted": true}'::jsonb
       WHERE command_id = ${promoted.commandId}::uuid`);
    await setBox('stopped', {});

    const refreshed = await readRow(promoted.commandId);
    expect(
      await admitInboxPrompt({
        ...promoted,
        result: refreshed.result as Record<string, unknown>,
      } as SessionLifecycleCommandRow),
    ).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
  });

  test('a DELIVERED older prompt no longer holds anything back', async () => {
    const older = await enqueue('q_done', { createdAt: '2026-08-01T00:00:00.000Z' });
    const younger = await enqueue('q_next', { createdAt: '2026-08-02T00:00:00.000Z' });
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'succeeded'
       WHERE command_id = ${older.commandId}::uuid`);
    await setBox('stopped', {});

    expect(await admitInboxPrompt(younger)).toEqual({ admit: true });
  });
});

describe('requeueAbandonedPrompt against real rows', () => {
  async function deliver(clientMessageId: string, wireMessageId = WIRE_ID) {
    const row = await enqueue(clientMessageId, { wireMessageId });
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'succeeded', attempts = 2, result = '{"status":"delivered"}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);
    return row;
  }

  test('matches by the wire id and hands the prompt back with a fresh budget', async () => {
    const row = await deliver('q_abandoned');

    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: WIRE_ID,
        turnToken: 'turn-1',
        endReason: 'abandoned',
      }),
    ).toBe('requeued');

    const after = await readRow(row.commandId);
    expect(after.status).toBe('queued');
    // A fresh delivery budget: the spent attempts were charged to a turn that
    // provably never ran.
    expect(after.attempts).toBe(0);
    expect(after.last_error).toBe('redelivered after abandoned');
    expect(after.result).toEqual({ redelivered_from: 'turn-1' });
    // The counter MERGES; the prompt body survives.
    const payload = after.payload as Record<string, unknown>;
    expect(payload.redeliveries).toBe(1);
    expect(payload.wireMessageId).toBe(WIRE_ID);
    expect(payload.parts).toEqual([{ type: 'text', text: 'say hi' }]);
  });

  test('a SECOND reaper pass over the same turn cannot requeue it twice', async () => {
    // The `status = 'succeeded'` predicate in the UPDATE is what makes this
    // safe: after the first requeue the row is `queued` and no longer matches.
    await deliver('q_race');
    await requeueAbandonedPrompt({
      sessionId: SESSION_ID,
      wireMessageId: WIRE_ID,
      turnToken: 'turn-1',
      endReason: 'abandoned',
    });

    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: WIRE_ID,
        turnToken: 'turn-1',
        endReason: 'abandoned',
      }),
    ).toBe('already_settled');
  });

  test('a wire id nothing was delivered under matches no prompt', async () => {
    await deliver('q_other');
    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: 'msg_0198000000000000000000000',
        turnToken: 'turn-1',
        endReason: 'runtime_gone',
      }),
    ).toBe('no_prompt');
  });

  test('the RE-MINTED id of a later redelivery still finds its prompt', async () => {
    const row = await deliver('q_reminted');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET payload = payload || '{"redeliveries":1,"redeliveredMessageId":"msg_0198f3a1b2c5ZzYyXxWwVvUu"}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);

    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: 'msg_0198f3a1b2c5ZzYyXxWwVvUu',
        turnToken: 'turn-2',
        endReason: 'runtime_gone',
      }),
    ).toBe('requeued');
    expect((await readRow(row.commandId)).payload).toMatchObject({ redeliveries: 2 });
  });

  test('the 4th abandonment dead-letters instead of looping for ever', async () => {
    const row = await deliver('q_exhausted');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET payload = payload || '{"redeliveries":3}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);

    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: WIRE_ID,
        turnToken: 'turn-9',
        endReason: 'abandoned',
      }),
    ).toBe('exhausted');
    expect((await readRow(row.commandId)).status).toBe('dead_lettered');
  });
});

/** A `continue_session` row written by an AUTOMATION: a schedule trigger fire,
 *  a Slack delivery, an approval resume. Same command type, no inbox fields. */
async function enqueueAutomationPrompt(text: string): Promise<SessionLifecycleCommandRow> {
  const { row } = await enqueueContinueSessionCommand({
    source: 'trigger:cron',
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: null,
    text,
    triggerSlug: 'daily-digest',
  });
  return row;
}

describe('the inbox is scoped to prompts the USER made', () => {
  test('an automation prompt is never listed as the user’s queued message', async () => {
    await enqueueAutomationPrompt('Your pending approval was approved — continue.');
    await enqueue('q_mine');

    const listed = await listInboxPrompts(SESSION_ID, 200);
    expect(listed.map((r) => (r.payload as Record<string, unknown>).clientMessageId)).toEqual([
      'q_mine',
    ]);
  });

  test('an automation prompt cannot be deleted through the prompt routes', async () => {
    const automation = await enqueueAutomationPrompt('trigger says hello');

    expect(await deleteInboxPrompt(SESSION_ID, automation.commandId)).toEqual({
      outcome: 'missing',
    });
    expect((await readRow(automation.commandId)).status).toBe('queued');
  });

  test('an automation prompt cannot be retried through the prompt routes either', async () => {
    const automation = await enqueueAutomationPrompt('trigger says hello');
    expect(await retryInboxPrompt(SESSION_ID, automation.commandId)).toBeNull();
  });

  test('the user’s own prompt still deletes', async () => {
    const mine = await enqueue('q_removable');
    const removed = await deleteInboxPrompt(SESSION_ID, mine.commandId);
    // The removal HANDS BACK the row it destroyed. `DELETE` is a hard delete
    // and the UI offers an undo, so this response is the only place the full
    // body — every part, every override, untruncated — still exists.
    expect(removed.outcome).toBe('deleted');
    expect(
      removed.outcome === 'deleted'
        ? (removed.row.payload as Record<string, unknown>).clientMessageId
        : null,
    ).toBe('q_removable');
  });

  test('a prompt already on the wire answers `delivering`, not `missing`', async () => {
    const mine = await enqueue('q_onwire');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${mine.commandId}::uuid`);
    expect(await deleteInboxPrompt(SESSION_ID, mine.commandId)).toEqual({
      outcome: 'delivering',
    });
  });
});

describe('holding the queue — what the Stop button now writes', () => {
  test('a held prompt is not due, and does not block the next one the user sends', async () => {
    const held = await enqueue('q_held', { createdAt: '2026-08-01T00:00:00.000Z' });
    expect(await holdInboxPrompts(SESSION_ID, true)).toBe(1);

    const after = await readRow(held.commandId);
    expect(after.result).toEqual({ held: true });

    // The whole point: a prompt sent AFTER the stop is not queued behind a row
    // that is, by construction, never due.
    const next = await enqueue('q_after_stop', { createdAt: '2026-08-02T00:00:00.000Z' });
    await setBox('stopped', {});
    expect(await admitInboxPrompt(next)).toEqual({ admit: true });
  });

  test('releasing makes every held row due again', async () => {
    const held = await enqueue('q_release');
    await holdInboxPrompts(SESSION_ID, true);
    expect(await holdInboxPrompts(SESSION_ID, false)).toBe(1);

    const after = await readRow(held.commandId);
    expect(after.result).toEqual({});
    const claimed = await claimDueLifecycleCommands({ workerId: 'w-release', limit: 10 });
    expect(claimed.map((r) => r.commandId)).toContain(held.commandId);
  });

  test('"send now" promotes ONE row past the order gate and releases the hold', async () => {
    const first = await enqueue('q_first', { createdAt: '2026-08-01T00:00:00.000Z' });
    const second = await enqueue('q_second', { createdAt: '2026-08-02T00:00:00.000Z' });
    await holdInboxPrompts(SESSION_ID, true);
    await setBox('stopped', {});

    const promoted = await retryInboxPrompt(SESSION_ID, second.commandId);
    expect(promoted?.commandId).toBe(second.commandId);
    // The row the user pointed at runs, even though an older one is pending.
    expect(await admitInboxPrompt(promoted!)).toEqual({ admit: true });
    // And the rest of the queue is released, to drain at the next boundary.
    expect((await readRow(first.commandId)).result).toEqual({});
  });
});

describe('a claim nobody is working on is reclaimed, not left to wedge the session', () => {
  test('a `running` row whose lock expired a full grace ago is claimed again', async () => {
    const stranded = await enqueue('q_stranded');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running',
             locked_by = 'dead-pod',
             locked_until = now() - interval '11 minutes'
       WHERE command_id = ${stranded.commandId}::uuid`);

    const claimed = await claimDueLifecycleCommands({ workerId: 'w-reclaim', limit: 10 });
    expect(claimed.map((r) => r.commandId)).toContain(stranded.commandId);
    expect((await readRow(stranded.commandId)).locked_by).toBe('w-reclaim');
  });

  test('a `running` row whose worker is merely slow is left alone', async () => {
    const working = await enqueue('q_working');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running',
             locked_by = 'live-pod',
             locked_until = now() + interval '2 minutes'
       WHERE command_id = ${working.commandId}::uuid`);

    const claimed = await claimDueLifecycleCommands({ workerId: 'w-nope', limit: 10 });
    expect(claimed.map((r) => r.commandId)).not.toContain(working.commandId);
    expect(LIFECYCLE_RUNNING_RECLAIM_GRACE_MS).toBeGreaterThan(0);
  });
});

describe('a dead-lettered prompt does not take the session down with it', () => {
  async function sessionStatus(): Promise<string> {
    const result = await db.execute(sql`
      SELECT status FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`);
    const rows = ((result as { rows?: Array<Record<string, unknown>> }).rows ??
      result) as Array<Record<string, unknown>>;
    return rows[0].status as string;
  }

  test('a browser prompt that dead-letters leaves the session running', async () => {
    const mine = await enqueue('q_dead');
    await markCommandFailed(mine.commandId, 'delivery outcome: failed', {
      retryable: false,
      attempts: 5,
      sessionId: SESSION_ID,
    });

    expect((await readRow(mine.commandId)).status).toBe('dead_lettered');
    // The user is watching, the row shows `failed`, and there is a retry
    // button. Parking their session would take a working session away.
    expect(await sessionStatus()).toBe('running');
  });

  test('an AUTOMATION prompt that dead-letters still parks the session', async () => {
    // Unchanged, and load-bearing: `findReusableTriggerSession` skips failed
    // sessions, so the next fire of a `session_mode: "reuse"` trigger creates a
    // fresh one instead of re-aiming at a wedged session.
    const automation = await enqueueAutomationPrompt('trigger prompt');
    await markCommandFailed(automation.commandId, 'delivery outcome: failed', {
      retryable: false,
      attempts: 5,
      sessionId: SESSION_ID,
    });

    expect(await sessionStatus()).toBe('failed');
    await db.execute(sql`
      UPDATE kortix.project_sessions SET status = 'running' WHERE session_id = ${SESSION_ID}`);
  });
});
