/**
 * Integration test (real local PostgreSQL): the lease a worker holds on a
 * claimed `session_lifecycle_commands` row.
 *
 * A claim is fenced by its `locked_by`. The writes that end the claim apply
 * only while the row is still `running` under that owner; a heartbeat renews
 * the owner's lock; an expired lock is reclaimed under a new owner. Every case
 * claims rows through the shipped `claimDueLifecycleCommands` and reads the
 * rows back.
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
  type SessionLifecycleCommandRow,
  claimDueLifecycleCommands,
  enqueueContinueSessionCommand,
  markCommandFailed,
  markCommandForwarded,
  markCommandSucceeded,
  requeueForAdmission,
} from '../projects/session-lifecycle/store';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];

let project: SeededProject;
const sessionId = crypto.randomUUID();

async function enqueue(label: string): Promise<SessionLifecycleCommandRow> {
  const clientMessageId = `${label}-${crypto.randomUUID()}`;
  const { row } = await enqueueContinueSessionCommand({
    source: 'ui',
    projectId: project.project_id,
    accountId: project.account_id,
    sessionId,
    actorUserId: null,
    text: 'hello',
    idempotencyKey: `prompt:${sessionId}:${clientMessageId}`,
    clientMessageId,
    wireMessageId: `msg_${clientMessageId}`,
    parts: [{ type: 'text', text: 'hello' }],
  });
  return row;
}

function claim(row: SessionLifecycleCommandRow, workerId: string) {
  return claimDueLifecycleCommands({ workerId, limit: 1, idempotencyKey: row.idempotencyKey! });
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
      select status, locked_by, locked_until, result
        from kortix.session_lifecycle_commands where command_id = ${commandId}::uuid`),
  );
  return row as { status: string; locked_by: string | null; locked_until: Date | string | null; result: Row };
}

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
       'default', 'running', '{}'::jsonb)`);
});

afterAll(async () => {
  await db.execute(
    sql`delete from kortix.session_lifecycle_commands where session_id = ${sessionId}`,
  );
  await db.execute(sql`delete from kortix.project_sessions where session_id = ${sessionId}`);
  await removeSeeded([project]);
});

describe('writes that end a claim are fenced by the lease', () => {
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
