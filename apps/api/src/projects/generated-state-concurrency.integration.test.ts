import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, accounts, createDb, projects } from '@kortix/db';
import { projectSessions, projectTasks } from '@kortix/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  TaskClaimConflictError,
  TaskLivenessRequestInFlightError,
  admitProjectTaskWorkerIteration,
  claimProjectTask,
  createProjectTask,
  getProjectTask,
  projectTaskWorkerAdmissionState,
  registerProjectTaskWorker,
  settleProjectTaskWorkerAdmission,
  sweepTaskLivenessBounds,
} from './generated-state-store';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000b701';
const PROJECT_ID = '00000000-0000-4000-a000-00000000b702';
const USER_ID = '00000000-0000-4000-a000-00000000b703';
const COORDINATORS = ['concurrency-coordinator-a', 'concurrency-coordinator-b', 'concurrency-coordinator-c'];
const WORKERS = ['concurrency-worker-a', 'concurrency-worker-b', 'concurrency-worker-c'];
const ZERO_USAGE = {
  total_cost: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  request_count: 0,
};

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 8 });
  return integrationDb;
}

async function cleanup(): Promise<void> {
  const database = testDb();
  await database.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await database.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed(): Promise<void> {
  const database = testDb();
  await database.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Liveness concurrency proof' });
  await database.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Liveness concurrency proof',
    repoUrl: 'https://example.test/liveness-concurrency.git',
  });
  await database.insert(projectSessions).values([
    ...COORDINATORS.map((sessionId, index) => ({
      sessionId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      branchName: `coordinator-${index}`,
      agentName: 'coordinator',
      createdBy: USER_ID,
    })),
    ...WORKERS.map((sessionId, index) => ({
      sessionId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      branchName: `worker-${index}`,
      agentName: 'worker',
      createdBy: USER_ID,
      metadata: { spawned_by_session: COORDINATORS[index], task_liveness_binding_required: true },
    })),
    {
      sessionId: 'ordinary-delegated-session',
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      branchName: 'ordinary-delegated',
      agentName: 'worker',
      createdBy: USER_ID,
      metadata: { spawned_by_session: COORDINATORS[0] },
    },
  ]);
}

async function bindWorker(index: number, now: Date, maxTokens = 1_000) {
  const database = testDb();
  const created = await createProjectTask(database, {
    projectId: PROJECT_ID,
    goalSlug: 'liveness-concurrency',
    title: `Bound task ${index}`,
    origin: `concurrency-proof-${index}`,
  });
  await claimProjectTask(database, {
    projectId: PROJECT_ID,
    taskId: created.task.taskId,
    sessionId: COORDINATORS[index],
    now,
    leaseMs: 3_600_000,
  });
  await registerProjectTaskWorker(database, {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    taskId: created.task.taskId,
    claimSessionId: COORDINATORS[index],
    workerSessionId: WORKERS[index],
    actorUserId: USER_ID,
    prompt: `Execute bounded task ${index}`,
    contract: {
      max_wall_seconds: 3_600,
      max_tokens: maxTokens,
      max_cost_usd: 10,
      max_iterations: 10,
    },
    now,
  });
  return created.task;
}

describeWithDb('task liveness concurrency — real PostgreSQL', () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  test('one coordinator cannot win concurrent claims on two tasks, and an expired claim is reclaimed', async () => {
    const database = testDb();
    const tasks = await Promise.all([0, 1].map((index) => createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'coordinator-exclusivity',
      title: `Exclusive coordinator task ${index}`,
      origin: `claim-race-${index}`,
    })));
    const now = new Date('2026-08-07T17:00:00.000Z');
    const results = await Promise.allSettled(tasks.map(({ task }) => claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: task.taskId,
      sessionId: COORDINATORS[0],
      now,
      leaseMs: 30_000,
    })));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(TaskClaimConflictError);

    const rows = await database.select().from(projectTasks);
    expect(rows.filter((row) => row.claimSessionId === COORDINATORS[0])).toHaveLength(1);
    const loser = tasks.find(({ task }) => task.claimSessionId == null &&
      !rows.find((row) => row.taskId === task.taskId)?.claimSessionId);
    expect(loser).toBeDefined();
    await expect(database.update(projectTasks).set({
      status: 'doing',
      claimSessionId: COORDINATORS[0],
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + 30_000),
    }).where(eq(projectTasks.taskId, loser!.task.taskId)).execute()).rejects.toThrow();
    const reclaimed = await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: loser!.task.taskId,
      sessionId: COORDINATORS[0],
      now: new Date(now.getTime() + 30_000),
      leaseMs: 30_000,
    });
    expect(reclaimed.claimSessionId).toBe(COORDINATORS[0]);
    const after = await database.select().from(projectTasks);
    expect(after.filter((row) => row.claimSessionId === COORDINATORS[0])).toHaveLength(1);
  });

  test('one snapshot distinguishes ordinary sessions, spawned-unbound workers, and committed bindings', async () => {
    const now = new Date('2026-08-07T17:30:00.000Z');
    expect(await projectTaskWorkerAdmissionState(testDb(), COORDINATORS[0])).toBe('not_worker');
    expect(await projectTaskWorkerAdmissionState(testDb(), 'ordinary-delegated-session')).toBe('not_worker');
    expect(await projectTaskWorkerAdmissionState(testDb(), WORKERS[0])).toBe('spawned_unbound');
    await bindWorker(0, now);
    expect(await projectTaskWorkerAdmissionState(testDb(), WORKERS[0])).toBe('bound');
  });

  test('concurrent gateway admissions acquire one durable fence and settlement releases only its owner', async () => {
    const database = testDb();
    const now = new Date('2026-08-07T18:00:00.000Z');
    const task = await bindWorker(0, now);
    const results = await Promise.allSettled(['req-a', 'req-b'].map((requestId) =>
      admitProjectTaskWorkerIteration(database, {
        workerSessionId: WORKERS[0],
        requestId,
        usage: ZERO_USAGE,
        now: new Date(now.getTime() + 1_000),
      }),
    ));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(TaskLivenessRequestInFlightError);
    }
    const admitted = results.find((result) => result.status === 'fulfilled');
    if (admitted?.status !== 'fulfilled' || !admitted.value) throw new Error('admission missing');
    expect((await getProjectTask(database, { projectId: PROJECT_ID, taskId: task.taskId })))
      .toMatchObject({ livenessIterationsAdmitted: 1, livenessAdmissionId: admitted.value.admissionId });

    expect(await settleProjectTaskWorkerAdmission(database, {
      workerSessionId: WORKERS[0],
      admissionId: 'not-the-owner',
      usage: ZERO_USAGE,
      now: new Date(now.getTime() + 2_000),
    })).toBe(false);
    expect(await settleProjectTaskWorkerAdmission(database, {
      workerSessionId: WORKERS[0],
      admissionId: admitted.value.admissionId,
      usage: ZERO_USAGE,
      now: new Date(now.getTime() + 2_000),
    })).toBe(true);

    const next = await admitProjectTaskWorkerIteration(database, {
      workerSessionId: WORKERS[0],
      requestId: 'req-next',
      usage: ZERO_USAGE,
      now: new Date(now.getTime() + 3_000),
    });
    expect(next?.admissionId).toBe('req-next');
    expect((await getProjectTask(database, { projectId: PROJECT_ID, taskId: task.taskId })))
      .toMatchObject({ livenessIterationsAdmitted: 2, livenessAdmissionId: 'req-next' });
  });

  test('recurring limited sweeps rotate checked rows so an exhausted worker cannot starve', async () => {
    const database = testDb();
    const now = new Date('2026-08-07T19:00:00.000Z');
    await Promise.all([bindWorker(0, now), bindWorker(1, now), bindWorker(2, now, 10)]);
    const calls: string[] = [];
    let finalized = 0;
    for (let iteration = 1; iteration <= 6; iteration += 1) {
      finalized += await sweepTaskLivenessBounds(
        database,
        new Date(now.getTime() + iteration * 1_000),
        1,
        async ({ sessionId }) => {
          calls.push(sessionId);
          if (sessionId === WORKERS[0]) throw new Error('transient ledger read failure');
          return sessionId === WORKERS[2] ? { ...ZERO_USAGE, total_tokens: 11 } : ZERO_USAGE;
        },
      );
    }

    expect(calls).toContain(WORKERS[2]);
    expect(finalized).toBe(1);
    const exhausted = (await database.select().from(projectTasks))
      .find((row) => row.livenessWorkerSessionId === WORKERS[2]);
    expect(exhausted).toMatchObject({ status: 'blocked', livenessBlocker: 'max_tokens exceeded' });
  });

  test('a loader failure plus cursor-write failure cannot abort later selected rows', async () => {
    const database = testDb();
    const now = new Date('2026-08-07T20:00:00.000Z');
    await Promise.all([bindWorker(0, now), bindWorker(1, now), bindWorker(2, now, 10)]);
    for (let index = 0; index < WORKERS.length; index += 1) {
      await database.update(projectTasks).set({
        livenessLastSweptAt: new Date(now.getTime() - (3 - index) * 1_000),
      }).where(eq(projectTasks.livenessWorkerSessionId, WORKERS[index]));
    }
    await database.execute(sql.raw(`
      create or replace function kortix.test_fail_liveness_cursor_update()
      returns trigger language plpgsql as $$
      begin
        if old.liveness_worker_session_id = '${WORKERS[0]}'
           and new.liveness_last_swept_at is distinct from old.liveness_last_swept_at then
          raise exception 'forced cursor update failure';
        end if;
        return new;
      end $$;
      create trigger test_fail_liveness_cursor_update
      before update on kortix.project_tasks
      for each row execute function kortix.test_fail_liveness_cursor_update();
    `));

    const calls: string[] = [];
    try {
      const finalized = await sweepTaskLivenessBounds(
        database,
        new Date(now.getTime() + 1_000),
        3,
        async ({ sessionId }) => {
          calls.push(sessionId);
          if (sessionId === WORKERS[0]) throw new Error('forced loader failure');
          return sessionId === WORKERS[2] ? { ...ZERO_USAGE, total_tokens: 11 } : ZERO_USAGE;
        },
      );
      expect(calls).toEqual(WORKERS);
      expect(finalized).toBe(1);
      const exhausted = (await database.select().from(projectTasks))
        .find((row) => row.livenessWorkerSessionId === WORKERS[2]);
      expect(exhausted?.status).toBe('blocked');
    } finally {
      await database.execute(sql.raw(`
        drop trigger if exists test_fail_liveness_cursor_update on kortix.project_tasks;
        drop function if exists kortix.test_fail_liveness_cursor_update();
      `));
    }
  });

});
