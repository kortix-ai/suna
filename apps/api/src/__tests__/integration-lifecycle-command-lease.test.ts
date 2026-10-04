/**
 * Integration test (real local PostgreSQL): the durable
 * `session_lifecycle_commands` queue.
 *
 * - A claim is fenced by its `locked_by`. The writes that end the claim apply
 *   only while the row is still `running` under that owner; a heartbeat renews
 *   the owner's lock; an expired lock is reclaimed under a new owner.
 * - A create claim persists the signals its replay needs, and an inline claim
 *   is reclaimable.
 * - `markCommandFailed` decides retry versus dead-letter, and its log level.
 * - A prompt whose runtime is down is parked, backed off, and re-armed.
 *
 * Every case drives the shipped writers and reads the rows back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  LIFECYCLE_CLAIM_LOCK_MS,
  heartbeatCommandLease,
  withCommandLeaseHeartbeat,
} from '../projects/session-lifecycle/command-lease';
import {
  LIFECYCLE_RUNNING_RECLAIM_GRACE_MS,
  MAX_RUNTIME_UNREACHABLE_RETRIES,
  RUNTIME_UNREACHABLE_REASON,
  type SessionLifecycleCommandRow,
  claimCreateSessionCommand,
  claimDueLifecycleCommands,
  enqueueContinueSessionCommand,
  markCommandFailed,
  markCommandForwarded,
  markCommandSucceeded,
  parkPromptForUnreachableRuntime,
  reArmRuntimeBlockedPrompts,
  requeueForAdmission,
} from '../projects/session-lifecycle/store';
import type { CreateSessionCommand } from '../projects/session-lifecycle/types';
import { logger } from '../lib/logger';
import { db } from '../lib/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];

let project: SeededProject;
const sessionId = crypto.randomUUID();
/** A second session, so the re-arm cases count only their own parked rows. */
const rearmSessionId = crypto.randomUUID();
/** The session a create command made before its post-create step failed. */
const createdSessionId = crypto.randomUUID();
/** Owns its own `session_sandboxes` row, so the deadline-extend cases never
 *  race the deadline of a box another test in this file also touches. */
const deadlineSessionId = crypto.randomUUID();
const deadlineSandboxId = crypto.randomUUID();

async function enqueue(label: string, forSession = sessionId): Promise<SessionLifecycleCommandRow> {
  const clientMessageId = `${label}-${crypto.randomUUID()}`;
  const { row } = await enqueueContinueSessionCommand({
    source: 'ui',
    projectId: project.project_id,
    accountId: project.account_id,
    sessionId: forSession,
    actorUserId: null,
    text: 'hello',
    idempotencyKey: `prompt:${sessionId}:${clientMessageId}`,
    clientMessageId,
    wireMessageId: `msg_${clientMessageId}`,
    parts: [{ type: 'text', text: 'hello' }],
  });
  return row;
}

/** A `continue_session` row an AUTOMATION wrote: a trigger fire, no inbox
 *  fields. Unlike an inbox prompt, its dead-letter parks the session. */
async function enqueueAutomation(label: string): Promise<SessionLifecycleCommandRow> {
  const { row } = await enqueueContinueSessionCommand({
    source: 'trigger:cron',
    projectId: project.project_id,
    accountId: project.account_id,
    sessionId,
    actorUserId: null,
    text: label,
    triggerSlug: 'daily',
    // The claim below selects by key.
    idempotencyKey: `trigger:${sessionId}:${label}:${crypto.randomUUID()}`,
  });
  return row;
}

async function sessionRow(id: string) {
  const [row] = rows(
    await db.execute(
      sql`select status, error from kortix.project_sessions where session_id = ${id}`,
    ),
  );
  return row;
}

function claim(row: SessionLifecycleCommandRow, workerId: string, now?: Date) {
  return claimDueLifecycleCommands({
    workerId,
    limit: 1,
    idempotencyKey: row.idempotencyKey!,
    now,
  });
}

/** The claim's worker died: its lock expired a full reclaim grace ago. */
async function expireLock(row: SessionLifecycleCommandRow): Promise<void> {
  const expiredAt = new Date(
    Date.now() - LIFECYCLE_RUNNING_RECLAIM_GRACE_MS - LIFECYCLE_CLAIM_LOCK_MS,
  );
  await db.execute(sql`
    update kortix.session_lifecycle_commands
       set locked_until = ${expiredAt.toISOString()}::timestamptz
     where command_id = ${row.commandId}::uuid`);
}

async function read(commandId: string) {
  const [row] = rows(
    await db.execute(sql`
      select status, locked_by, locked_until, result, payload, attempts, available_at
        from kortix.session_lifecycle_commands where command_id = ${commandId}::uuid`),
  );
  return row as {
    status: string;
    locked_by: string | null;
    locked_until: Date | string | null;
    result: Row;
    payload: Row;
    attempts: number;
    available_at: Date | string;
  };
}

const ms = (value: Date | string) => new Date(value).getTime();

/** One row claimed by worker A, whose lock expired, then reclaimed by worker B. */
async function reclaimed(label: string) {
  const row = await enqueue(label);
  const [byA] = await claim(row, `worker-a-${label}`);
  expect(byA?.lockedBy).toBe(`worker-a-${label}`);
  await expireLock(row);
  const [byB] = await claim(row, `worker-b-${label}`);
  expect(byB?.lockedBy).toBe(`worker-b-${label}`);
  return { byA: byA!, byB: byB! };
}

beforeAll(async () => {
  project = await seedProject('lifecycle-command-lease-test');
  await db.execute(sql`
    insert into kortix.project_sessions
      (session_id, account_id, project_id, branch_name, agent_name, status, metadata)
    values
      (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId},
       'default', 'running', '{}'::jsonb),
      (${rearmSessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
       ${rearmSessionId}, 'default', 'running', '{}'::jsonb),
      (${createdSessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
       ${createdSessionId}, 'default', 'running', '{}'::jsonb),
      (${deadlineSessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
       ${deadlineSessionId}, 'default', 'running', '{}'::jsonb)`);
  await db.execute(sql`
    insert into kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, provider, external_id, status, deadline_at)
    values
      (${deadlineSandboxId}::uuid, ${deadlineSessionId}, ${project.account_id}::uuid,
       ${project.project_id}::uuid, 'daytona', ${`ext-${deadlineSandboxId}`}, 'active',
       now() + interval '1 minute')`);
});

afterAll(async () => {
  await db.execute(
    sql`delete from kortix.session_lifecycle_commands where project_id = ${project.project_id}::uuid`,
  );
  // The identity guard refuses to delete an established sandbox unless its
  // session is tombstoned first.
  await db.execute(sql`
    update kortix.project_sessions
       set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"now"}'::jsonb
     where session_id = ${deadlineSessionId}`);
  await db.execute(
    sql`delete from kortix.session_sandboxes where sandbox_id = ${deadlineSandboxId}::uuid`,
  );
  await db.execute(
    sql`delete from kortix.project_sessions where project_id = ${project.project_id}::uuid`,
  );
  await removeSeeded([project]);
});

async function sandboxDeadline(id: string): Promise<Date> {
  const [row] = rows(
    await db.execute(
      sql`select deadline_at, status from kortix.session_sandboxes where sandbox_id = ${id}::uuid`,
    ),
  );
  return new Date(row!.deadline_at as string);
}

describe('writes that end a claim are fenced by the lease', () => {
  test('two workers racing to reclaim one expired row get one lease and one attempt', async () => {
    const row = await enqueue('two-worker-race');
    const [initial] = await claim(row, 'worker-initial');
    expect(initial?.attempts).toBe(1);
    await expireLock(row);

    const [a, b] = await Promise.all([
      claim(row, 'worker-race-a'),
      claim(row, 'worker-race-b'),
    ]);
    expect(a.length + b.length).toBe(1);
    const winner = a[0] ?? b[0];
    expect(winner?.lockedBy).toBe(a.length ? 'worker-race-a' : 'worker-race-b');
    const persisted = await read(row.commandId);
    expect(persisted.status).toBe('running');
    expect(persisted.locked_by).toBe(winner.lockedBy);
    expect(persisted.attempts).toBe(2);
  });

  test('two workers claiming a batch get every due row exactly once, in queue order', async () => {
    const batchSession = crypto.randomUUID();
    await db.execute(sql`
      insert into kortix.project_sessions
        (session_id, account_id, project_id, branch_name, agent_name, status, metadata)
      values (${batchSession}, ${project.account_id}::uuid, ${project.project_id}::uuid,
              ${batchSession}, 'default', 'running', '{}'::jsonb)`);
    const queued: string[] = [];
    for (let i = 0; i < 6; i += 1) queued.push((await enqueue(`batch-${i}`, batchSession)).commandId);
    // Only this test's rows are due before the cutoff: push everything else out.
    const now = new Date(Date.now() + 60_000);
    await db.execute(sql`
      update kortix.session_lifecycle_commands
         set available_at = now() + interval '1 hour'
       where status = 'queued' and session_id is distinct from ${batchSession}`);

    const [a, b] = await Promise.all([
      claimDueLifecycleCommands({ workerId: 'batch-a', limit: 4, now }),
      claimDueLifecycleCommands({ workerId: 'batch-b', limit: 4, now }),
    ]);

    const ids = (claimed: SessionLifecycleCommandRow[]) => claimed.map((row) => row.commandId);
    expect([...ids(a), ...ids(b)].sort()).toEqual([...queued].sort());
    // Each worker's rows come back in the queue's order (send order here).
    expect(ids(a)).toEqual(queued.filter((id) => ids(a).includes(id)));
    expect(ids(b)).toEqual(queued.filter((id) => ids(b).includes(id)));
    for (const row of [...a, ...b]) {
      expect(row.status).toBe('running');
      expect(row.attempts).toBe(1);
    }
  });

  test("a reclaimed row ignores the first worker's late failure", async () => {
    const { byA, byB } = await reclaimed('late-fail');
    await markCommandFailed(byA, 'drain failed: stale worker', { retryable: true, attempts: 1 });
    const after = await read(byA.commandId);
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe(byB.lockedBy);

    // The owner's own write still lands.
    expect(await markCommandForwarded(byB, sessionId, 'msg_forwarded')).toBe(true);
    expect((await read(byA.commandId)).status).toBe('succeeded');
  });

  test("a reclaimed row ignores the first worker's late success", async () => {
    const { byA, byB } = await reclaimed('late-success');
    expect(await markCommandSucceeded(byA, { status: 'delivered' }, sessionId)).toBe(false);
    const after = await read(byA.commandId);
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe(byB.lockedBy);
  });

  test('a stale admission requeue does not take the row from its new owner', async () => {
    const { byA, byB } = await reclaimed('late-requeue');
    expect(await requeueForAdmission(byA, 'turn_active', new Date())).toBe(false);
    expect((await read(byA.commandId)).locked_by).toBe(byB.lockedBy);
  });

  test('a released row takes no write from the worker that released it', async () => {
    const row = await enqueue('released');
    const [held] = await claim(row, 'worker-released');
    expect(await requeueForAdmission(held!, 'older_prompt_pending', new Date())).toBe(true);
    expect(await markCommandSucceeded(held!, { status: 'delivered' }, sessionId)).toBe(false);
    expect((await read(row.commandId)).status).toBe('queued');
  });
});

describe('the heartbeat', () => {
  test("renews the owner's lock and refuses a worker whose row was reclaimed", async () => {
    const { byA, byB } = await reclaimed('heartbeat');
    expect(await heartbeatCommandLease(byA)).toBe(false);
    const before = new Date((await read(byB.commandId)).locked_until as string).getTime();
    const later = new Date(Date.now() + 60_000);
    expect(await heartbeatCommandLease(byB, later)).toBe(true);
    const after = new Date((await read(byB.commandId)).locked_until as string).getTime();
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(later.getTime() + LIFECYCLE_CLAIM_LOCK_MS);
  });

  test('keeps a long delivery from being reclaimed', async () => {
    const row = await enqueue('long-delivery');
    const [held] = await claim(row, 'worker-long');
    // The lock is already past its reclaim point when the work starts: only a
    // renewal can keep the row with its owner.
    await expireLock(row);
    await withCommandLeaseHeartbeat(
      held!,
      () => new Promise((resolve) => setTimeout(resolve, 250)),
      50,
    );
    expect(await claim(row, 'worker-thief')).toEqual([]);
    expect((await read(row.commandId)).locked_by).toBe('worker-long');
  });
});

describe('a create claim', () => {
  function createCommand(overrides: Partial<CreateSessionCommand> = {}): CreateSessionCommand {
    return {
      source: 'ui',
      project: {
        projectId: project.project_id,
        accountId: project.account_id,
      } as CreateSessionCommand['project'],
      userId: crypto.randomUUID(),
      requestingPrincipalType: 'human',
      body: { initial_prompt: 'hi' },
      idempotencyKey: `create:${crypto.randomUUID()}`,
      ...overrides,
    };
  }

  // A queued create replays from the persisted payload alone
  // (`create-session.ts`), so the session origin and the principal must
  // survive the durable queue, and a row written before those signals existed
  // must replay without them.
  test('persists the origin signals and the principal its replay needs', async () => {
    const { row: withSignals } = await claimCreateSessionCommand(
      createCommand({
        requestingPrincipalType: 'service_account',
        authType: 'pat',
        apiKeyType: 'user',
        inSession: false,
        postCreate: [{ type: 'apply_trigger_session_access', triggerSlug: 'daily' }],
      }),
      { initialStatus: 'queued' },
    );
    const { row: withoutSignals } = await claimCreateSessionCommand(createCommand(), {
      initialStatus: 'queued',
    });

    expect((await read(withSignals.commandId)).payload).toMatchObject({
      requestingPrincipalType: 'service_account',
      authType: 'pat',
      apiKeyType: 'user',
      inSession: false,
      postCreate: [{ type: 'apply_trigger_session_access', triggerSlug: 'daily' }],
      body: { initial_prompt: 'hi' },
    });
    const bare = (await read(withoutSignals.commandId)).payload;
    for (const key of ['authType', 'apiKeyType', 'inSession']) {
      expect(bare).not.toHaveProperty(key);
    }
  });

  // An inline create is claimed `running` by this process. Without a lock the
  // reclaim arm (`locked_until <= now - grace`) never matches it, and a pod
  // that dies mid-create leaves the idempotency key answering `pending` for ever.
  test('an inline claim holds its own lock, and is reclaimed once that lock expires', async () => {
    const { row: first } = await claimCreateSessionCommand(createCommand(), {
      initialStatus: 'running',
    });
    const { row: second } = await claimCreateSessionCommand(createCommand(), {
      initialStatus: 'running',
    });
    const [firstRow, secondRow] = [await read(first.commandId), await read(second.commandId)];
    expect(firstRow.status).toBe('running');
    expect(firstRow.locked_by).toStartWith('session-lifecycle-inline:');
    expect(firstRow.locked_by).not.toBe(secondRow.locked_by);
    expect(await claim(first, 'worker-too-early')).toEqual([]);

    await expireLock(first);

    const [reclaimedRow] = await claim(first, 'worker-reclaim');
    expect(reclaimedRow?.lockedBy).toBe('worker-reclaim');
  });

  test('a queued claim is unlocked, so the next drain takes it', async () => {
    const { row } = await claimCreateSessionCommand(createCommand(), { initialStatus: 'queued' });
    expect((await read(row.commandId)).locked_by).toBeNull();

    const [taken] = await claim(row, 'worker-drain');
    expect(taken?.commandId).toBe(row.commandId);
  });
});

describe('markCommandFailed decides retry or dead-letter', () => {
  /** Run `fn` and record which logger level each dead-letter line used. */
  async function logLevels(fn: () => Promise<void>): Promise<Array<{ level: string; context: Row }>> {
    const seen: Array<{ level: string; context: Row }> = [];
    const { warn, error } = logger;
    logger.warn = (message: string, context?: Row) => {
      if (message.includes('dead-lettered')) seen.push({ level: 'warn', context: context ?? {} });
    };
    logger.error = (message: string, context?: Row) => {
      if (message.includes('dead-lettered')) seen.push({ level: 'error', context: context ?? {} });
    };
    try {
      await fn();
    } finally {
      logger.warn = warn;
      logger.error = error;
    }
    return seen;
  }

  test('a non-retryable failure dead-letters on the first attempt, and pages', async () => {
    const row = await enqueue('dead-letter-first');
    const [held] = await claim(row, 'worker-dl');

    const logs = await logLevels(() =>
      markCommandFailed(held!, 'delivery outcome: no-session', { retryable: false, attempts: 1 }),
    );

    expect((await read(row.commandId)).status).toBe('dead_lettered');
    expect(logs).toEqual([
      {
        level: 'error',
        context: expect.objectContaining({
          command_id: row.commandId,
          command_type: 'continue_session',
          attempts: 1,
          error: 'delivery outcome: no-session',
        }),
      },
    ]);
  });

  // An automation prompt, because its dead-letter WOULD park the session: the
  // untouched session proves the row was requeued, not dead-lettered.
  test('a retryable failure below the attempt cap requeues after 2 s per attempt and leaves the session alone', async () => {
    const row = await enqueueAutomation('retry-below-cap');
    const [held] = await claim(row, 'worker-retry');
    const before = Date.now();

    const logs = await logLevels(() =>
      markCommandFailed(held!, 'delivery outcome: pending', {
        retryable: true,
        attempts: 2,
        sessionId,
      }),
    );
    const afterCall = Date.now();

    const after = await read(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.locked_by).toBeNull();
    expect(ms(after.available_at)).toBeGreaterThanOrEqual(before + 4_000);
    expect(ms(after.available_at)).toBeLessThanOrEqual(afterCall + 4_000);
    expect(logs).toEqual([]);
    expect((await sessionRow(sessionId))?.status).toBe('running');
  });

  test('a retryable failure AT the attempt cap dead-letters, and pages', async () => {
    const row = await enqueue('retry-at-cap');
    const [held] = await claim(row, 'worker-cap');

    const logs = await logLevels(() =>
      markCommandFailed(held!, 'delivery outcome: pending', { retryable: true, attempts: 5 }),
    );

    expect((await read(row.commandId)).status).toBe('dead_lettered');
    expect(logs.map((log) => log.level)).toEqual(['error']);
  });

  // A create whose post-create step failed dead-letters WITH the session it
  // made (`drain.ts`, `create-session.ts`). Only a `continue_session`
  // dead-letter parks a session; the session a create made stays usable.
  test('a create dead-letter pages and leaves the session it created alone', async () => {
    const { row } = await claimCreateSessionCommand(
      {
        source: 'ui',
        project: {
          projectId: project.project_id,
          accountId: project.account_id,
        } as CreateSessionCommand['project'],
        userId: crypto.randomUUID(),
        requestingPrincipalType: 'human',
        body: {},
        idempotencyKey: `create:${crypto.randomUUID()}`,
      },
      { initialStatus: 'queued' },
    );
    const [held] = await claim(row, 'worker-create-dl');

    const logs = await logLevels(() =>
      markCommandFailed(held!, 'post-create action failed', {
        retryable: true,
        attempts: 5,
        sessionId: createdSessionId,
      }),
    );

    expect((await read(row.commandId)).status).toBe('dead_lettered');
    expect(await sessionRow(createdSessionId)).toEqual({ status: 'running', error: null });
    expect(logs).toEqual([
      {
        level: 'error',
        context: expect.objectContaining({
          command_type: 'create_session',
          session_id: createdSessionId,
        }),
      },
    ]);
  });

  // Out of credits, an unentitled model, a forbidden workspace mode: the
  // customer's state, not a platform fault. It must not page.
  test('a customer-state cause logs a warning, not an error', async () => {
    const row = await enqueue('dead-letter-customer');
    const [held] = await claim(row, 'worker-customer');

    const logs = await logLevels(() =>
      markCommandFailed(held!, 'Out of credits. Top up to continue.', {
        retryable: false,
        attempts: 1,
      }),
    );

    expect(logs.map((log) => log.level)).toEqual(['warn']);
    expect(logs[0]?.context.cause).toBe('customer_state');
  });
});

describe('a prompt whose runtime is unreachable', () => {
  const T = new Date('2026-09-25T10:00:00.000Z');
  /** Later than both rows created during this test and the parked retry dates. */
  const LATER = new Date(Math.max(Date.now(), T.getTime()) + 24 * 60 * 60 * 1000);

  test('is parked, not failed: queued, its attempt given back, due after the first rung', async () => {
    const row = await enqueue('park-first');
    const [held] = await claim(row, 'worker-park', LATER);
    expect((await read(row.commandId)).attempts).toBe(1);

    expect(
      await parkPromptForUnreachableRuntime(held!, 'delivery outcome: unreachable', {
        sessionId,
        now: T,
      }),
    ).toEqual({ parked: true, retries: 1 });

    const after = await read(row.commandId);
    expect(after.status).toBe('queued');
    expect(after.locked_by).toBeNull();
    // A sleeping box is not the prompt failing: the dead-letter budget is untouched.
    expect(after.attempts).toBe(0);
    expect(ms(after.available_at)).toBe(T.getTime() + 30_000);
    expect(after.result).toEqual({
      delivery_blocked: RUNTIME_UNREACHABLE_REASON,
      runtime_retries: 1,
    });
    expect(after.payload).toMatchObject({ runtimeUnreachableRetries: 1, deliveryAttempt: 1 });
  });

  // Each re-attempt must carry a FRESH idempotency key (`deliveryAttempt`), or
  // the proxy's 10-minute dedupe claim swallows it and the row closes having
  // delivered nothing. The budget is bounded: the last attempt refuses to park,
  // and the caller dead-letters.
  test('backs off 30 s, 2 min, 8 min, then refuses once the budget is spent', async () => {
    const row = await enqueue('park-ladder');
    const dueAfter: number[] = [];
    for (let rung = 0; rung < MAX_RUNTIME_UNREACHABLE_RETRIES; rung += 1) {
      const [held] = await claim(row, `worker-ladder-${rung}`, LATER);
      await parkPromptForUnreachableRuntime(held!, 'x', { now: T });
      dueAfter.push(ms((await read(row.commandId)).available_at) - T.getTime());
    }
    expect(dueAfter).toEqual([30_000, 120_000, 480_000]);
    expect((await read(row.commandId)).payload).toMatchObject({
      runtimeUnreachableRetries: 3,
      deliveryAttempt: 3,
    });

    const [last] = await claim(row, 'worker-ladder-last', LATER);
    expect(await parkPromptForUnreachableRuntime(last!, 'x', { now: T })).toEqual({
      parked: false,
      retries: MAX_RUNTIME_UNREACHABLE_RETRIES,
    });
    const refused = await read(row.commandId);
    expect(refused.status).toBe('running');
    expect(refused.locked_by).toBe('worker-ladder-last');
  });

  test('carries a Stop that landed during delivery through the park as a hold', async () => {
    const row = await enqueue('park-stop');
    const [held] = await claim(row, 'worker-park-stop', LATER);
    await db.execute(sql`
      update kortix.session_lifecycle_commands
         set payload = payload || '{"stopPausedOnDelivery":"true"}'::jsonb
       where command_id = ${row.commandId}::uuid`);

    await parkPromptForUnreachableRuntime(held!, 'x', { now: T });

    const after = await read(row.commandId);
    expect(after.result).toMatchObject({ held: true, stop_paused: true });
    // Consumed here, or it re-lands on every later delivery of the same row.
    expect(after.payload).not.toHaveProperty('stopPausedOnDelivery');
  });

  test('parks nothing for an unknown command or for the stale worker of a reclaimed row', async () => {
    const unknown = { commandId: crypto.randomUUID(), lockedBy: 'worker-ghost' };
    expect(await parkPromptForUnreachableRuntime(unknown, 'x')).toEqual({
      parked: false,
      retries: 0,
    });

    const { byA, byB } = await reclaimed('park-stale');
    expect(await parkPromptForUnreachableRuntime(byA, 'x')).toEqual({ parked: false, retries: 0 });
    const after = await read(byA.commandId);
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe(byB.lockedBy);
  });

  // A wake is not consent to send: a HELD row (the user pressed Stop) stays
  // where it is.
  test('a runtime coming back makes its parked prompts due now, and leaves a held one', async () => {
    const parked: SessionLifecycleCommandRow[] = [];
    for (const label of ['rearm-a', 'rearm-b', 'rearm-held']) {
      const row = await enqueue(label, rearmSessionId);
      const [held] = await claim(row, `worker-${label}`, LATER);
      if (label === 'rearm-held') {
        await db.execute(sql`
          update kortix.session_lifecycle_commands
             set payload = payload || '{"stopPausedOnDelivery":"true"}'::jsonb
           where command_id = ${row.commandId}::uuid`);
      }
      await parkPromptForUnreachableRuntime(held!, 'x', { now: T });
      parked.push(row);
    }
    const heldDue = ms((await read(parked[2]!.commandId)).available_at);
    const back = new Date(T.getTime() + 5_000);

    expect(await reArmRuntimeBlockedPrompts(rearmSessionId, back)).toBe(2);

    expect(ms((await read(parked[0]!.commandId)).available_at)).toBe(back.getTime());
    expect(ms((await read(parked[1]!.commandId)).available_at)).toBe(back.getTime());
    expect(ms((await read(parked[2]!.commandId)).available_at)).toBe(heldDue);
    expect(await reArmRuntimeBlockedPrompts(crypto.randomUUID(), back)).toBe(0);
  });

  // The deadlock this suite exists to close: a queued prompt holds no turn
  // record, so nothing else keeps its box alive while it waits out the
  // backoff. Without a grant here the reaper can stop the box mid-ladder, and
  // the very next retry finds a box the platform itself just switched off.
  //
  // `extendSandboxDeadline` computes its grant from Postgres's own `now()`,
  // not the fixed `T` this suite uses for the command-queue math above, so
  // this case asserts against real wall-clock time with a generous tolerance
  // for how long the test itself takes to run.
  test('parking a prompt extends its still-active box past the retry ladder', async () => {
    const before = await sandboxDeadline(deadlineSandboxId);
    // Seeded 1 minute out in `beforeAll` — nowhere near the 15-minute grant.
    expect(before.getTime()).toBeLessThan(Date.now() + 5 * 60_000);

    const row = await enqueue('park-deadline', deadlineSessionId);
    const [held] = await claim(row, 'worker-park-deadline', LATER);

    await parkPromptForUnreachableRuntime(held!, 'x', { sessionId: deadlineSessionId, now: T });

    const after = await sandboxDeadline(deadlineSandboxId);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(after.getTime()).toBeGreaterThanOrEqual(Date.now() + 14 * 60_000);
    expect(after.getTime()).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
  });

  // The grant is capped to boxes the reaper has not already reaped — it must
  // never look like this call can revive a stopped box.
  test('parking a prompt for a stopped box does not touch its deadline', async () => {
    const stoppedSandboxId = crypto.randomUUID();
    const stoppedSessionId = crypto.randomUUID();
    const stoppedDeadline = new Date(Date.now() - 60_000);
    await db.execute(sql`
      insert into kortix.project_sessions
        (session_id, account_id, project_id, branch_name, agent_name, status, metadata)
      values (${stoppedSessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
              ${stoppedSessionId}, 'default', 'running', '{}'::jsonb)`);
    // Insert active first — the anchor-guard trigger forces a fresh INSERT's
    // deadline to the 15-minute boot floor whenever it is not already in the
    // future, which a stopped row with a past deadline always is. The
    // active→stopped UPDATE below is the transition a real idle stop makes,
    // and the trigger leaves an explicit `deadline_at` alone on it.
    await db.execute(sql`
      insert into kortix.session_sandboxes
        (sandbox_id, session_id, account_id, project_id, provider, external_id, status)
      values (${stoppedSandboxId}::uuid, ${stoppedSessionId}, ${project.account_id}::uuid,
              ${project.project_id}::uuid, 'daytona', ${`ext-${stoppedSandboxId}`}, 'active')`);
    await db.execute(sql`
      update kortix.session_sandboxes
         set status = 'stopped', deadline_at = ${stoppedDeadline.toISOString()}::timestamptz
       where sandbox_id = ${stoppedSandboxId}::uuid`);
    try {
      const row = await enqueue('park-stopped', stoppedSessionId);
      const [held] = await claim(row, 'worker-park-stopped', LATER);

      await parkPromptForUnreachableRuntime(held!, 'x', { sessionId: stoppedSessionId, now: T });

      expect((await sandboxDeadline(stoppedSandboxId)).toISOString()).toBe(
        stoppedDeadline.toISOString(),
      );
    } finally {
      await db.execute(sql`
        update kortix.project_sessions
           set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"now"}'::jsonb
         where session_id = ${stoppedSessionId}`);
      await db.execute(
        sql`delete from kortix.session_sandboxes where sandbox_id = ${stoppedSandboxId}::uuid`,
      );
      await db.execute(
        sql`delete from kortix.project_sessions where session_id = ${stoppedSessionId}`,
      );
    }
  });
});
