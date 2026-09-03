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
  admitInboxPrompt,
  sessionHoldsTurnAuthority,
} from '../projects/session-lifecycle/inbox-admission';
import {
  confirmInboxPromptConsumed,
  reconcileForwardedPrompts,
} from '../projects/session-lifecycle/consumption';
import {
  deleteInboxPrompt,
  holdInboxPrompts,
  listInboxPrompts,
  releaseInboxHold,
  retryInboxPrompt,
} from '../projects/session-lifecycle/inbox-rows';
import { requeueAbandonedPrompt } from '../projects/session-lifecycle/redelivery';
import { acceptSandboxTurn } from '../projects/sandbox-turn-lifecycle';
import {
  LIFECYCLE_RUNNING_RECLAIM_GRACE_MS,
  type SessionLifecycleCommandRow,
  claimDueLifecycleCommands,
  enqueueContinueSessionCommand,
  markCommandFailed,
  markCommandForwarded,
  promoteNextInboxRow,
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
  overrides: { wireMessageId?: string; createdAt?: string; clientSentAtMs?: number } = {},
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
    clientSentAtMs: overrides.clientSentAtMs,
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

  test('one send order governs listing, admission, and terminal promotion', async () => {
    const sentAt = Date.now();
    // The first Enter loses the HTTP/insert race. This is the screenshot's
    // exact shape: the first optimistic bubble is correct, but a refresh reads
    // the rows back in the opposite database creation order.
    const first = await enqueue('q_interstellar', {
      wireMessageId: 'msg_000000000001FirstPromptWire',
      clientSentAtMs: sentAt,
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    const second = await enqueue('q_raju', {
      wireMessageId: 'msg_000000000002SecondPromptWir',
      clientSentAtMs: sentAt + 1,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await setBox('stopped', {});

    expect((await listInboxPrompts(SESSION_ID, 200)).map((row) => row.commandId)).toEqual([
      first.commandId,
      second.commandId,
    ]);
    expect(await admitInboxPrompt(first)).toEqual({ admit: true });
    expect(await admitInboxPrompt(second)).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });

    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET available_at = now() + interval '5 minutes',
             result = '{"admission_reason":"turn_active"}'::jsonb
       WHERE command_id IN (${first.commandId}::uuid, ${second.commandId}::uuid)`);
    expect(await promoteNextInboxRow(SESSION_ID)).toBe(first.idempotencyKey);
  });
});

describe('requeueForAdmission against real Postgres', () => {
  test('gives the claim back and stamps WHY the prompt is waiting', async () => {
    const row = await enqueue('q_wait');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running', attempts = 3, locked_by = 'worker-1'
       WHERE command_id = ${row.commandId}::uuid`);

    await requeueForAdmission(row.commandId, 'older_prompt_pending', new Date(Date.now() + 2_000));

    const after = await readRow(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(2);
    expect(after.locked_by).toBeNull();
    expect(after.result).toEqual({ admission_reason: 'older_prompt_pending', admission_refusals: 1 });
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
    await requeueForAdmission(row.commandId, 'older_prompt_pending', new Date());
    await requeueForAdmission(row.commandId, 'older_prompt_pending', new Date());
    await requeueForAdmission(row.commandId, 'older_prompt_pending', new Date());
    expect((await readRow(row.commandId)).result).toEqual({
      admission_reason: 'older_prompt_pending',
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
    await requeueForAdmission(row.commandId, 'older_prompt_pending', new Date());
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
    await requeueForAdmission(row.commandId, 'older_prompt_pending', new Date());
    expect((await readRow(row.commandId)).result).toEqual({
      kept: true,
      admission_reason: 'older_prompt_pending',
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

  test('a live turn on a RUNNING box no longer holds a prompt back', async () => {
    // The turn-active refusal is deleted. OpenCode persists a mid-turn prompt
    // and runs it in arrival order after the turn in flight ends, so the row
    // goes straight out instead of costing the user up to 10s of dead air.
    const row = await enqueue('q_admit');
    await setBox('active', turn);
    expect(await admitInboxPrompt(row)).toEqual({ admit: true });

    // The authority itself is unchanged — this is a change to ADMISSION only.
    // `GET .../turn` and `settleOrphanedSandboxTurns` read the same predicate
    // and still see a busy session.
    const box = await db.execute(sql`
      SELECT status, metadata FROM kortix.session_sandboxes
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
    const boxRows = ((box as { rows?: Array<Record<string, unknown>> }).rows ?? box) as Array<
      Record<string, unknown>
    >;
    expect(
      sessionHoldsTurnAuthority({
        status: boxRows[0].status as string,
        metadata: boxRows[0].metadata as Record<string, unknown>,
      }),
    ).toBe(true);
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

  test('giving up on a FORWARDED row stops it claiming to be on the wire', async () => {
    // Every reader of "is this row at OpenCode" keys on `result.status`.
    // Leaving `forwarded` on a dead-lettered row made it read `delivering` for
    // ever: filtered out of the queue strip, counted as live work by the
    // composer, and invisible to the sweep — no retry, no remove, nothing that
    // could ever close it.
    const row = await enqueue('q_exhausted_forwarded');
    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET payload = payload || '{"redeliveries":3}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);

    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: WIRE_ID,
        turnToken: 'turn-10',
        endReason: 'abandoned',
      }),
    ).toBe('exhausted');

    const after = await readRow(row.commandId);
    expect(after.status).toBe('dead_lettered');
    expect((after.result as Record<string, unknown>).status).toBeUndefined();
    // Still the user's row: a dead-lettered prompt is listed, with a retry.
    expect((await listInboxPrompts(SESSION_ID, 200)).map((r) => r.commandId)).toContain(
      row.commandId,
    );
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
    // Target this row. A developer database can contain unrelated due commands,
    // so a global ten-row claim does not prove whether this row became due.
    if (!held.idempotencyKey) throw new Error('inbox row has no idempotency key');
    const claimed = await claimDueLifecycleCommands({
      workerId: 'w-release',
      limit: 1,
      idempotencyKey: held.idempotencyKey,
    });
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

describe('a FORWARDED prompt stays open until the ledger confirms it', () => {
  async function forward(clientMessageId: string, wireMessageId = WIRE_ID) {
    const row = await enqueue(clientMessageId, { wireMessageId });
    await markCommandForwarded(row.commandId, SESSION_ID, wireMessageId);
    return row;
  }

  async function openTurn(token: string, messageId: string, state: 'active' | 'ended', endReason?: string) {
    await db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id, message_id, state, end_reason,
         started_at, created_at, updated_at)
      VALUES (${token}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid,
              ${messageId}, ${state}, ${endReason ?? null},
              now(), now(), now())
      ON CONFLICT (turn_token) DO UPDATE
         SET state = EXCLUDED.state, end_reason = EXCLUDED.end_reason`);
  }

  async function ageRow(commandId: string, ms: number) {
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET updated_at = now() - make_interval(secs => ${ms / 1000})
       WHERE command_id = ${commandId}::uuid`);
  }

  test('the row is `succeeded` for the drain and STILL LISTED for the user', async () => {
    // Both halves matter. `claimDueLifecycleCommands` must never re-claim it —
    // that would be a second delivery — and `listInboxPrompts` must keep it, or
    // the composer has nothing to show between the send and the turn.
    const row = await forward('q_forwarded');
    const after = await readRow(row.commandId);
    expect(after.status).toBe('succeeded');
    expect(after.result).toMatchObject({ status: 'forwarded', forwarded_message_id: WIRE_ID });
    expect(after.locked_by).toBeNull();

    expect((await listInboxPrompts(SESSION_ID, 200)).map((r) => r.commandId)).toEqual([
      row.commandId,
    ]);
    const claimed = await claimDueLifecycleCommands({ workerId: 'w-forwarded', limit: 10 });
    expect(claimed.map((r) => r.commandId)).not.toContain(row.commandId);
  });

  test('a forwarded prompt cannot be removed or re-sent — OpenCode has the message', async () => {
    const row = await forward('q_forwarded_actions');
    expect(await deleteInboxPrompt(SESSION_ID, row.commandId)).toEqual({ outcome: 'delivering' });
    expect(await retryInboxPrompt(SESSION_ID, row.commandId)).toBeNull();
    expect((await readRow(row.commandId)).status).toBe('succeeded');
  });

  test('the ledger confirming the wire id closes it, and it leaves the list', async () => {
    const row = await forward('q_confirm');
    expect(await confirmInboxPromptConsumed(SESSION_ID, WIRE_ID)).toBe('confirmed');

    const after = await readRow(row.commandId);
    // MERGED: the forwarding record survives the confirmation, so the row still
    // says which id it went out under.
    expect(after.result).toMatchObject({ status: 'delivered', forwarded_message_id: WIRE_ID });
    expect(await listInboxPrompts(SESSION_ID, 200)).toEqual([]);
    // Idempotent: both witnesses (acceptance, then completion) can fire.
    expect(await confirmInboxPromptConsumed(SESSION_ID, WIRE_ID)).toBe('no_prompt');
  });

  test('the RE-MINTED id of a redelivery confirms the same row', async () => {
    const row = await forward('q_confirm_reminted');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET payload = payload || '{"redeliveredMessageId":"msg_0198f3a1b2c5ZzYyXxWwVvUu"}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);
    expect(await confirmInboxPromptConsumed(SESSION_ID, 'msg_0198f3a1b2c5ZzYyXxWwVvUu')).toBe(
      'confirmed',
    );
    expect((await readRow(row.commandId)).result).toMatchObject({ status: 'delivered' });
  });

  test('the sweep closes a row whose turn RAN but whose confirmation never landed', async () => {
    const row = await forward('q_sweep_ran');
    await ageRow(row.commandId, 60_000);
    await openTurn(`sweep-ran-${SANDBOX_ID}`, WIRE_ID, 'ended', 'completed');

    const result = await reconcileForwardedPrompts();
    expect(result.confirmed).toBeGreaterThanOrEqual(1);
    expect((await readRow(row.commandId)).result).toMatchObject({ status: 'delivered' });
  });

  test('the sweep leaves a never-ran ending inside the ceiling to the redelivery', async () => {
    const row = await forward('q_sweep_abandoned');
    await ageRow(row.commandId, 60_000);
    await openTurn(`sweep-abandoned-${SANDBOX_ID}`, WIRE_ID, 'ended', 'runtime_gone');

    await reconcileForwardedPrompts();
    expect((await readRow(row.commandId)).result).toMatchObject({ status: 'forwarded' });
  });

  test('a STOP-PAUSED row is never swept — the user is holding it, not a lost witness', async () => {
    const row = await forward('q_sweep_stopped');
    expect(await holdInboxPrompts(SESSION_ID, true)).toBe(1);
    expect((await readRow(row.commandId)).result).toMatchObject({
      status: 'forwarded',
      stop_paused: true,
      held: true,
    });
    await ageRow(row.commandId, 3 * 60 * 60_000);

    await reconcileForwardedPrompts();
    expect((await readRow(row.commandId)).result).toMatchObject({ stop_paused: true });
  });

  test('releasing the hold puts a stop-paused row back ON THE QUEUE, due now', async () => {
    // Not back to `forwarded`: the reaper does not reliably hand a stopped
    // prompt back (measured — an aborted turn leaves an assistant husk, so the
    // daemon never calls it orphaned), and a released row left `forwarded`
    // would sit in `delivering` until the sweep force-closed it, never run.
    // The drain's already-answered guard is what makes re-queueing safe.
    const row = await forward('q_release_stopped');
    await holdInboxPrompts(SESSION_ID, true);
    expect(await holdInboxPrompts(SESSION_ID, false)).toBe(1);

    const after = await readRow(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.result).toEqual({});
    expect(after.attempts).toBe(0);
    // And it goes out under a re-minted id: the hold stamped the durable
    // marker, so the drain re-reads the transcript before delivering.
    expect((after.payload as Record<string, unknown>).remintOnDelivery).toBe(true);

    const claimed = await claimDueLifecycleCommands({ workerId: 'w-released', limit: 10 });
    expect(claimed.map((r) => r.commandId)).toContain(row.commandId);
  });

  test('a released row runs BEFORE a prompt sent after it', async () => {
    // The ordering the user sees: Stop, then type something new. The stopped
    // prompt was submitted first, so it goes first — `POST .../prompts`
    // releases the hold, and the admission gate then orders by `created_at`.
    const stopped = await forward('q_release_order_first');
    await holdInboxPrompts(SESSION_ID, true);
    const newer = await enqueue('q_release_order_second', {
      wireMessageId: 'msg_0198f3a1b2c5ZzYyXxWwVvUu',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await releaseInboxHold(SESSION_ID);

    expect(await admitInboxPrompt({ ...newer } as SessionLifecycleCommandRow)).toEqual({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: INBOX_ORDER_BACKOFF_MS,
    });
    const refreshed = await readRow(stopped.commandId);
    expect(refreshed.status).toBe('queued');
  });

  test('a stop-paused row is REMOVABLE — the user stopped it, so it is theirs to drop', async () => {
    // The strip renders it as a held queue row with a remove button. A 409 there
    // is a control that cannot work: the row is out of the drain's way, nothing
    // is going to deliver it, and only removing it takes it off the screen.
    const row = await forward('q_stopped_remove');
    await holdInboxPrompts(SESSION_ID, true);

    const removed = await deleteInboxPrompt(SESSION_ID, row.commandId);
    expect(removed.outcome).toBe('deleted');
    expect(await listInboxPrompts(SESSION_ID, 200)).toEqual([]);
  });

  test('a stop-paused row can be SENT NOW — the same row, promoted and re-minted', async () => {
    // The other control the strip offers on a held row. `retryInboxPrompt` is
    // "send now"; refusing the row it is rendered on left the user with two
    // buttons and no way out of the hold but typing something else.
    const row = await forward('q_stopped_sendnow');
    await holdInboxPrompts(SESSION_ID, true);

    const promoted = await retryInboxPrompt(SESSION_ID, row.commandId);
    expect(promoted?.commandId).toBe(row.commandId);
    const after = await readRow(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.result).toEqual({ promoted: true });
    // It went out once already, so it must not go out under the same id again.
    expect((after.payload as Record<string, unknown>).remintOnDelivery).toBe(true);
  });

  test('a CONSUMED stop-paused row is never re-queued by the release', async () => {
    // The race the release predicate has to survive: Stop marks the row, and
    // the turn in front of it ends before the abort lands, so OpenCode runs the
    // prompt anyway and the ledger confirms it. Re-queueing there spends a
    // SECOND real LLM turn on a message that was already answered.
    const row = await forward('q_stopped_consumed');
    await holdInboxPrompts(SESSION_ID, true);
    expect(await confirmInboxPromptConsumed(SESSION_ID, WIRE_ID)).toBe('confirmed');

    // The confirmation closes the row, and a closed row carries no user hold.
    const confirmed = await readRow(row.commandId);
    expect(confirmed.result).toMatchObject({ status: 'delivered' });
    expect((confirmed.result as Record<string, unknown>).stop_paused).toBeUndefined();
    expect((confirmed.result as Record<string, unknown>).held).toBeUndefined();

    expect(await releaseInboxHold(SESSION_ID)).toBe(0);
    expect((await readRow(row.commandId)).status).toBe('succeeded');
  });

  test('the release requeue reads FORWARDED, not the stop marker alone', async () => {
    // Belt and braces for the case above: even a row that somehow kept the
    // marker after being delivered must not go back on the queue. `forwarded`
    // is what "OpenCode is still holding this, unanswered" means.
    const row = await forward('q_stopped_marker_only');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = '{"status":"delivered","stop_paused":true,"held":true}'::jsonb
       WHERE command_id = ${row.commandId}::uuid`);

    expect(await releaseInboxHold(SESSION_ID)).toBe(0);
    expect((await readRow(row.commandId)).status).toBe('succeeded');
  });

  test('a prompt the drain has ALREADY CLAIMED is stop-paused too', async () => {
    // A `running` row is inside `continueSession`, which can sit there for a
    // whole cold boot. It is neither `queued` nor forwarded yet, so the two
    // hold arms miss it — and the delivery that follows would put the very
    // prompt the user pressed Stop to get ahead of onto the wire, unheld.
    const row = await enqueue('q_stopped_running');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${row.commandId}::uuid`);

    expect(await holdInboxPrompts(SESSION_ID, true)).toBe(1);
    expect((await readRow(row.commandId)).payload).toMatchObject({
      stopPausedOnDelivery: true,
      remintOnDelivery: true,
    });

    // The delivery lands anyway — nothing can recall a POST — and it comes back
    // held rather than as an ordinary forwarded row.
    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    expect((await readRow(row.commandId)).result).toMatchObject({
      status: 'forwarded',
      stop_paused: true,
      held: true,
    });

    // And the user's next send puts it back on the queue, exactly like a row
    // that was already forwarded when Stop was pressed.
    expect(await releaseInboxHold(SESSION_ID)).toBe(1);
    expect((await readRow(row.commandId)).status).toBe('queued');
  });

  test('releasing clears the pending stop mark on a row still on the wire', async () => {
    // Otherwise the mark outlives the hold it belongs to: the next delivery of
    // that row would come back stop-paused with nothing having stopped it.
    const row = await enqueue('q_stopped_running_released');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${row.commandId}::uuid`);
    await holdInboxPrompts(SESSION_ID, true);
    await releaseInboxHold(SESSION_ID);

    expect(
      (await readRow(row.commandId)).payload as Record<string, unknown>,
    ).not.toHaveProperty('stopPausedOnDelivery');
    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    const after = (await readRow(row.commandId)).result as Record<string, unknown>;
    expect(after.status).toBe('forwarded');
    expect(after.stop_paused).toBeUndefined();
  });

  test('a stop-paused prompt the reaper hands back comes back HELD, not due', async () => {
    // The whole point of the marker: Stop aborted the turn, so the reaper reads
    // the persisted-but-unanswered message as abandoned and requeues it. Due-now
    // would deliver the prompt the user just stopped, one reaper pass later.
    const row = await forward('q_stopped_requeue');
    await holdInboxPrompts(SESSION_ID, true);

    expect(
      await requeueAbandonedPrompt({
        sessionId: SESSION_ID,
        wireMessageId: WIRE_ID,
        turnToken: 'turn-stopped',
        endReason: 'abandoned',
      }),
    ).toBe('requeued');

    const after = await readRow(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.result).toMatchObject({ held: true });
    // Visible, but not due: nothing claims it until the user releases the hold.
    const claimed = await claimDueLifecycleCommands({ workerId: 'w-stopped', limit: 10 });
    expect(claimed.map((r) => r.commandId)).not.toContain(row.commandId);
  });

  test('ACCEPTANCE closes the row through the delivery that is still in flight', async () => {
    // The order the real code runs in: `forwardToSandbox` awaits
    // `acceptSandboxTurn` INSIDE the POST, so the acceptance witness arrives
    // while the row is still `running` and `markCommandForwarded` has not run.
    // The confirmation cannot close a row the drain still owns, so it marks the
    // payload and the drain's own write lands it.
    const row = await enqueue('q_accept_inflight');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${row.commandId}::uuid`);

    expect(await confirmInboxPromptConsumed(SESSION_ID, WIRE_ID)).toBe('pending_delivery');
    expect((await readRow(row.commandId)).payload).toMatchObject({ consumedOnDelivery: true });

    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    const after = await readRow(row.commandId);
    // DELIVERED, not `forwarded`: a turn has the message, so the composer must
    // not keep showing it as a pending queue row for the length of that turn.
    expect(after.result).toMatchObject({ status: 'delivered', forwarded_message_id: WIRE_ID });
    expect(await listInboxPrompts(SESSION_ID, 200)).toEqual([]);
    // The marker is CONSUMED, so a later delivery of this row cannot re-read it.
    expect(after.payload as Record<string, unknown>).not.toHaveProperty('consumedOnDelivery');
  });

  test('a delivery a turn ACCEPTED is not mislabelled as stop-paused', async () => {
    // Stop marks a `running` row it cannot recall, and the POST lands anyway.
    // If OpenCode ACCEPTED it, the message is running in the transcript — the
    // strip must not show it as a parked queue row with a "send now" button,
    // and the next release must not deliver it a second time.
    const row = await enqueue('q_accept_beats_stop');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${row.commandId}::uuid`);
    await holdInboxPrompts(SESSION_ID, true);
    expect(await confirmInboxPromptConsumed(SESSION_ID, WIRE_ID)).toBe('pending_delivery');

    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    const after = await readRow(row.commandId);
    expect(after.result).toMatchObject({ status: 'delivered' });
    expect((after.result as Record<string, unknown>).stop_paused).toBeUndefined();
    expect((after.result as Record<string, unknown>).held).toBeUndefined();
    expect(after.payload as Record<string, unknown>).not.toHaveProperty('stopPausedOnDelivery');

    // And the release finds nothing to put back on the queue.
    expect(await releaseInboxHold(SESSION_ID)).toBe(0);
    expect((await readRow(row.commandId)).status).toBe('succeeded');
  });

  test('the stop mark is CONSUMED by the delivery it lands on, not left on the row', async () => {
    // Otherwise every LATER delivery of that row re-lands stop-paused + held:
    // the release strips the mark only from `running` rows, and a re-queued row
    // is `queued` by then. The prompt the user explicitly re-sent would come
    // back parked, invisible to the sweep, and strandable for ever.
    const row = await enqueue('q_stop_mark_consumed');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${row.commandId}::uuid`);
    await holdInboxPrompts(SESSION_ID, true);
    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    expect((await readRow(row.commandId)).payload as Record<string, unknown>).not.toHaveProperty(
      'stopPausedOnDelivery',
    );

    // The user sends the row again; the second delivery is an ordinary one.
    await releaseInboxHold(SESSION_ID);
    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    const after = (await readRow(row.commandId)).result as Record<string, unknown>;
    expect(after.status).toBe('forwarded');
    expect(after.stop_paused).toBeUndefined();
    expect(after.held).toBeUndefined();
  });

  test('a re-queued row goes out under a NEW idempotency key, not the swallowed one', async () => {
    // `forwardToSandbox` claims `idem:<sandbox>\0<session>\0<key>` for
    // DEDUPE_TTL_MS (10 min). Re-POSTing a stopped-then-released prompt under
    // the SAME key inside that window is answered `200 {"deduplicated":true}`,
    // which `postPrompt` reads as delivered: OpenCode never receives the
    // message and the row is force-closed 10 minutes later with no error.
    // `payload.deliveryAttempt` is what suffixes the key — see
    // `executeQueuedContinue`.
    const row = await forward('q_release_new_key');
    expect((await readRow(row.commandId)).payload as Record<string, unknown>).not.toHaveProperty(
      'deliveryAttempt',
    );

    await holdInboxPrompts(SESSION_ID, true);
    await releaseInboxHold(SESSION_ID);
    expect((await readRow(row.commandId)).payload).toMatchObject({ deliveryAttempt: 1 });

    // And "send now" on a stop-paused row is the other advertised way out of a
    // Stop, so it needs the same fresh key.
    await markCommandForwarded(row.commandId, SESSION_ID, WIRE_ID);
    await holdInboxPrompts(SESSION_ID, true);
    await retryInboxPrompt(SESSION_ID, row.commandId);
    expect((await readRow(row.commandId)).payload).toMatchObject({ deliveryAttempt: 2 });
  });

  test('acceptSandboxTurn confirms from the STORED identity, with no argument', async () => {
    // The only caller that carries an inbox prompt is the proxy, and it calls
    // `acceptSandboxTurn({ externalId }, token)` with no third argument — the
    // identity was written durably by `beginSandboxTurn` before the POST.
    // Reading only the argument made this confirmation dead for every composer
    // prompt: `messageId` was null, and the confirm returned before touching a
    // row.
    const row = await enqueue('q_accept_stored_identity');
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET status = 'running'
       WHERE command_id = ${row.commandId}::uuid`);
    const token = `accept-stored-${SANDBOX_ID}`;
    await setBox('active', {
      [token]: {
        token,
        state: 'delivering',
        opencodeSessionId: 'ses_root',
        messageId: WIRE_ID,
        startedAtMs: Date.now(),
      },
    });

    expect(await acceptSandboxTurn({ sandboxId: SANDBOX_ID }, token)).toBe(true);
    expect((await readRow(row.commandId)).payload).toMatchObject({ consumedOnDelivery: true });
  });

  test('the release does NOT spend the reaper redelivery budget', async () => {
    // `deliveryAttempt` is a separate counter from `redeliveries` on purpose:
    // `requeueAbandonedPrompt` dead-letters past MAX_PROMPT_REDELIVERIES, and a
    // user who stops and re-sends three times must not lose the automatic
    // repair that exists for a prompt a turn really did drop.
    const row = await forward('q_release_budget');
    await holdInboxPrompts(SESSION_ID, true);
    await releaseInboxHold(SESSION_ID);
    expect((await readRow(row.commandId)).payload as Record<string, unknown>).not.toHaveProperty(
      'redeliveries',
    );
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
