import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, accounts, createDb, projects } from '@kortix/db';
import {
  projectGoalObservations,
  projectSessions,
  projectTasks,
  sessionLifecycleCommands,
} from '@kortix/db/schema';
import { eq } from 'drizzle-orm';
import {
  TaskClaimConflictError,
  TaskTransitionConflictError,
  TaskLivenessConflictError,
  TaskLivenessLimitExceededError,
  admitProjectTaskWorkerIteration,
  claimProjectTask,
  createProjectTask,
  getProjectTask,
  listProjectGoalObservations,
  recordProjectGoalObservation,
  recordProjectTaskProgress,
  registerProjectTaskWorker,
  settleProjectTaskNoProgress,
  sweepTaskLivenessBounds,
  transitionProjectTask,
} from './generated-state-store';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000a701';
const PROJECT_ID = '00000000-0000-4000-a000-00000000a702';
const SESSION_A = 'generated-state-session-a';
const SESSION_B = 'generated-state-session-b';
const SESSION_C = 'generated-state-session-c';
const SESSION_D = 'generated-state-session-d';
const USER_A = '00000000-0000-4000-a000-00000000a703';
const USER_B = '00000000-0000-4000-a000-00000000a704';

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 8 });
  return integrationDb;
}

async function cleanup() {
  const database = testDb();
  await database.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await database.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed() {
  const database = testDb();
  await database.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Generated state proof' });
  await database.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Generated state proof',
    repoUrl: 'https://example.test/generated-state.git',
  });
  await database.insert(projectSessions).values([
    {
      sessionId: SESSION_A,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      branchName: 'generated-state-a',
      agentName: 'builder',
      createdBy: USER_A,
    },
    {
      sessionId: SESSION_B,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      branchName: 'generated-state-b',
      agentName: 'reviewer',
      createdBy: USER_B,
      metadata: { spawned_by_session: SESSION_A },
    },
    {
      sessionId: SESSION_C, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
      branchName: 'generated-state-c', agentName: 'reviewer', createdBy: USER_B,
      metadata: { spawned_by_session: SESSION_A },
    },
    {
      sessionId: SESSION_D, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
      branchName: 'generated-state-d', agentName: 'reviewer', createdBy: USER_B,
      metadata: { spawned_by_session: SESSION_A },
    },
  ]);
}

describeWithDb('generated task and goal-observation state — real PostgreSQL', () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  test('task creation is project-idempotent by a non-null origin fingerprint', async () => {
    const database = testDb();
    const first = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'First materialization',
      body: 'Original task body',
      origin: 'goal-evaluator',
      originFingerprint: 'goal:ship-kernel:task:compile',
      priority: 20,
    });
    const retry = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'A retry must not overwrite the task',
      body: 'Different retry body',
      origin: 'goal-evaluator',
      originFingerprint: 'goal:ship-kernel:task:compile',
      priority: 90,
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.task.taskId).toBe(first.task.taskId);
    expect(retry.task.title).toBe('First materialization');
    expect(retry.task.priority).toBe(20);

    const anonymous = await Promise.all(
      [0, 1].map((index) =>
        createProjectTask(database, {
          projectId: PROJECT_ID,
          goalSlug: 'ship-kernel',
          title: `Anonymous ${index}`,
          origin: 'human',
        }),
      ),
    );
    expect(new Set(anonymous.map(({ task }) => task.taskId)).size).toBe(2);
  });

  test('database constraints reject dual assignees, self-blocking, and non-finite observations', async () => {
    const database = testDb();
    await expect(
      database
        .insert(projectTasks)
        .values({
          projectId: PROJECT_ID,
          goalSlug: 'ship-kernel',
          title: 'Invalid dual assignment',
          origin: 'constraint-proof',
          assigneeAgent: 'builder',
          assigneeUserId: '00000000-0000-4000-a000-00000000a799',
        })
        .execute(),
    ).rejects.toThrow();

    const selfBlockedId = '00000000-0000-4000-a000-00000000a798';
    await expect(
      database
        .insert(projectTasks)
        .values({
          taskId: selfBlockedId,
          projectId: PROJECT_ID,
          goalSlug: 'ship-kernel',
          title: 'Invalid self dependency',
          origin: 'constraint-proof',
          blockedBy: [selfBlockedId],
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      database
        .insert(projectGoalObservations)
        .values({
          projectId: PROJECT_ID,
          goalSlug: 'ship-kernel',
          metric: 'invalid_metric',
          value: Number.NaN,
          source: 'constraint-proof',
          observedAt: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  test('one conditional update protects a live claim and permits reclaim after expiry', async () => {
    const database = testDb();
    const { task } = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Exclusive task',
      origin: 'goal-evaluator',
    });
    const claimedAt = new Date('2026-08-07T10:00:00.000Z');
    const first = await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: task.taskId,
      sessionId: SESSION_A,
      now: claimedAt,
      leaseMs: 30_000,
    });
    expect(first.status).toBe('doing');
    expect(first.claimSessionId).toBe(SESSION_A);
    expect(first.claimExpiresAt?.toISOString()).toBe('2026-08-07T10:00:30.000Z');

    await expect(
      claimProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: task.taskId,
        sessionId: SESSION_B,
        now: new Date('2026-08-07T10:00:29.999Z'),
        leaseMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(TaskClaimConflictError);

    const stillOwned = await database.query.projectTasks.findFirst({
      where: eq(projectTasks.taskId, task.taskId),
    });
    expect(stillOwned?.claimSessionId).toBe(SESSION_A);
    expect(stillOwned?.claimExpiresAt?.toISOString()).toBe('2026-08-07T10:00:30.000Z');

    const reclaimed = await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: task.taskId,
      sessionId: SESSION_B,
      now: new Date('2026-08-07T10:00:30.000Z'),
      leaseMs: 45_000,
    });
    expect(reclaimed.status).toBe('doing');
    expect(reclaimed.claimSessionId).toBe(SESSION_B);
    expect(reclaimed.claimExpiresAt?.toISOString()).toBe('2026-08-07T10:01:15.000Z');
  });

  test('the atomic claim enforces the referenced session agent and user assignees', async () => {
    const database = testDb();
    const agentAssigned = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Builder-only task',
      origin: 'assignment-proof',
      assigneeAgent: 'builder',
    });
    const userAssigned = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'User-only task',
      origin: 'assignment-proof',
      assigneeUserId: USER_A,
    });
    const unassigned = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Open task',
      origin: 'assignment-proof',
    });
    const now = new Date('2026-08-07T10:15:00.000Z');

    for (const assigned of [agentAssigned, userAssigned]) {
      await expect(
        claimProjectTask(database, {
          projectId: PROJECT_ID,
          taskId: assigned.task.taskId,
          sessionId: SESSION_B,
          now,
          leaseMs: 30_000,
        }),
      ).rejects.toBeInstanceOf(TaskClaimConflictError);
      expect(
        await database.query.projectTasks.findFirst({
          where: eq(projectTasks.taskId, assigned.task.taskId),
        }),
      ).toMatchObject({ status: 'backlog', claimSessionId: null });

      const claimed = await claimProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: assigned.task.taskId,
        sessionId: SESSION_A,
        now,
        leaseMs: 30_000,
      });
      expect(claimed.claimSessionId).toBe(SESSION_A);
    }

    const openClaim = await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: unassigned.task.taskId,
      sessionId: SESSION_B,
      now,
      leaseMs: 30_000,
    });
    expect(openClaim.claimSessionId).toBe(SESSION_B);
  });

  test('claims only ready work, waits for dependencies, and never reclaims terminal tasks', async () => {
    const database = testDb();
    const dependency = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Required task',
      origin: 'dependency-proof',
      status: 'todo',
    });
    const dependent = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Dependent task',
      origin: 'dependency-proof',
      status: 'todo',
      blockedBy: [dependency.task.taskId],
    });
    const now = new Date('2026-08-07T10:30:00.000Z');

    await expect(
      claimProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: dependent.task.taskId,
        sessionId: SESSION_A,
        now,
        leaseMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(TaskClaimConflictError);

    const claimedDependency = await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: dependency.task.taskId,
      sessionId: SESSION_A,
      now,
      leaseMs: 30_000,
    });
    expect(claimedDependency.status).toBe('doing');
    await transitionProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: dependency.task.taskId,
      status: 'done',
      expectedClaimSessionId: SESSION_A,
      result: { evidence: [{ ref: 'dependency-proof' }] },
      now: new Date('2026-08-07T10:30:01.000Z'),
    });

    const claimedDependent = await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: dependent.task.taskId,
      sessionId: SESSION_B,
      now: new Date('2026-08-07T10:30:02.000Z'),
      leaseMs: 30_000,
    });
    expect(claimedDependent.status).toBe('doing');
    await transitionProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: dependent.task.taskId,
      status: 'done',
      expectedClaimSessionId: SESSION_B,
      result: { evidence: [{ ref: 'dependent-proof' }] },
      now: new Date('2026-08-07T10:30:03.000Z'),
    });

    await expect(
      claimProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: dependent.task.taskId,
        sessionId: SESSION_A,
        now: new Date('2026-08-07T10:30:04.000Z'),
        leaseMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(TaskClaimConflictError);
  });

  test('concurrent contenders produce one claim and distinct claim conflicts', async () => {
    const database = testDb();
    const { task } = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Contended task',
      origin: 'goal-evaluator',
    });
    const results = await Promise.allSettled(
      [SESSION_A, SESSION_B].map((sessionId) =>
        claimProjectTask(database, {
          projectId: PROJECT_ID,
          taskId: task.taskId,
          sessionId,
          now: new Date('2026-08-07T11:00:00.000Z'),
          leaseMs: 60_000,
        }),
      ),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(TaskClaimConflictError);
    }
  });

  test('done and blocked transitions clear claim ownership atomically', async () => {
    const database = testDb();
    const doneTask = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Complete me',
      origin: 'transition-proof',
    });
    const blockedTask = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Block me',
      origin: 'transition-proof',
    });
    const now = new Date('2026-08-07T12:30:00.000Z');
    await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: doneTask.task.taskId,
      sessionId: SESSION_A,
      now,
      leaseMs: 60_000,
    });
    await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: blockedTask.task.taskId,
      sessionId: SESSION_A,
      now,
      leaseMs: 60_000,
    });

    const done = await transitionProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: doneTask.task.taskId,
      status: 'done',
      expectedClaimSessionId: SESSION_A,
      result: { evidence: [{ kind: 'test', ref: 'generated-state-proof' }] },
      now: new Date('2026-08-07T12:30:01.000Z'),
    });
    const blocked = await transitionProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: blockedTask.task.taskId,
      status: 'blocked',
      expectedClaimSessionId: SESSION_A,
      result: { blocker: 'Waiting for reviewer input' },
      now: new Date('2026-08-07T12:30:02.000Z'),
    });

    for (const transitioned of [done, blocked]) {
      expect(transitioned?.claimSessionId).toBeNull();
      expect(transitioned?.claimedAt).toBeNull();
      expect(transitioned?.claimExpiresAt).toBeNull();
    }
    expect(done?.status).toBe('done');
    expect(done?.result).toEqual({
      evidence: [{ kind: 'test', ref: 'generated-state-proof' }],
    });
    expect(done?.updatedAt.toISOString()).toBe('2026-08-07T12:30:01.000Z');
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.result).toEqual({
      blocker: 'Waiting for reviewer input',
    });
    expect(blocked?.updatedAt.toISOString()).toBe('2026-08-07T12:30:02.000Z');
  });

  test('terminal transitions require the supplied session to hold a live unexpired claim', async () => {
    const database = testDb();
    const neverClaimed = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Never claimed',
      origin: 'transition-proof',
    });
    const expired = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Expired claim',
      origin: 'transition-proof',
    });
    await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: expired.task.taskId,
      sessionId: SESSION_A,
      now: new Date('2026-08-07T12:45:00.000Z'),
      leaseMs: 30_000,
    });

    await expect(
      transitionProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: neverClaimed.task.taskId,
        status: 'done',
        expectedClaimSessionId: SESSION_A,
        result: { evidence: [{ ref: 'invalid-never-claimed' }] },
        now: new Date('2026-08-07T12:45:01.000Z'),
      }),
    ).rejects.toBeInstanceOf(TaskTransitionConflictError);
    await expect(
      transitionProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: expired.task.taskId,
        status: 'blocked',
        expectedClaimSessionId: SESSION_A,
        result: { blocker: 'invalid-expired-claim' },
        now: new Date('2026-08-07T12:45:30.000Z'),
      }),
    ).rejects.toBeInstanceOf(TaskTransitionConflictError);

    expect(
      await getProjectTask(database, { projectId: PROJECT_ID, taskId: neverClaimed.task.taskId }),
    ).toMatchObject({ status: 'backlog', claimSessionId: null, result: {} });
    expect(
      await getProjectTask(database, { projectId: PROJECT_ID, taskId: expired.task.taskId }),
    ).toMatchObject({
      status: 'doing',
      claimSessionId: SESSION_A,
      result: {},
    });
  });

  test('a transition cannot overwrite another session live claim', async () => {
    const database = testDb();
    const { task } = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Claim-protected transition',
      origin: 'transition-proof',
    });
    await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: task.taskId,
      sessionId: SESSION_A,
      now: new Date('2026-08-07T13:00:00.000Z'),
      leaseMs: 60_000,
    });

    await expect(
      transitionProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: task.taskId,
        status: 'done',
        expectedClaimSessionId: SESSION_B,
        now: new Date('2026-08-07T13:00:30.000Z'),
      }),
    ).rejects.toBeInstanceOf(TaskTransitionConflictError);

    const unchanged = await getProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: task.taskId,
    });
    expect(unchanged?.status).toBe('doing');
    expect(unchanged?.claimSessionId).toBe(SESSION_A);
    expect(unchanged?.claimExpiresAt?.toISOString()).toBe('2026-08-07T13:01:00.000Z');
  });

  test('worker registration and one continuation survive retries and process restarts', async () => {
    const database = testDb();
    const { task } = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Restart-safe liveness',
      origin: 'liveness-proof',
    });
    const claimedAt = new Date('2026-08-07T14:00:00.000Z');
    await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: task.taskId,
      sessionId: SESSION_A,
      now: claimedAt,
      leaseMs: 60_000,
    });
    const contract = {
      max_wall_seconds: 3_600,
      max_tokens: 50_000,
      max_cost_usd: 5,
      max_iterations: 10,
    };
    const registered = await registerProjectTaskWorker(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_A,
      workerSessionId: SESSION_B,
      actorUserId: null,
      prompt: 'Do the bounded task.',
      contract,
      now: claimedAt,
    });
    expect(registered.existing).toBe(false);
    expect(registered.task.claimExpiresAt?.toISOString()).toBe('2026-08-07T15:00:00.000Z');
    const retry = await registerProjectTaskWorker(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_A,
      workerSessionId: SESSION_B,
      actorUserId: null,
      prompt: 'Do the bounded task.',
      contract,
      now: new Date('2026-08-07T14:00:01.000Z'),
    });
    expect(retry.existing).toBe(true);
    expect(retry.commandId).toBe(registered.commandId);
    await expect(registerProjectTaskWorker(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_A,
      workerSessionId: SESSION_B,
      actorUserId: null,
      prompt: 'A changed prompt must conflict.',
      contract,
      now: new Date('2026-08-07T14:00:02.000Z'),
    })).rejects.toBeInstanceOf(TaskLivenessConflictError);

    const usage = {
      total_cost: 0.5,
      input_tokens: 100,
      output_tokens: 100,
      cached_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 200,
      request_count: 1,
    };
    await expect(admitProjectTaskWorkerIteration(database, {
      workerSessionId: SESSION_B,
      usage,
      now: new Date('2026-08-07T14:00:30.000Z'),
    })).resolves.toMatchObject({ taskId: task.taskId, admitted: true });

    const progressed = await recordProjectTaskProgress(database, {
      projectId: PROJECT_ID, taskId: task.taskId, claimSessionId: SESSION_A,
      workerSessionId: SESSION_B, ref: 'commit:abc123',
      now: new Date('2026-08-07T14:00:40.000Z'),
    });
    expect(progressed.lastProgressRef).toBe('commit:abc123');
    expect(progressed.lastProgressAt?.toISOString()).toBe('2026-08-07T14:00:40.000Z');
    await expect(recordProjectTaskProgress(database, {
      projectId: PROJECT_ID, taskId: task.taskId, claimSessionId: SESSION_A,
      workerSessionId: SESSION_C, ref: 'commit:impersonated',
      now: new Date('2026-08-07T14:00:41.000Z'),
    })).rejects.toBeInstanceOf(TaskLivenessConflictError);

    const first = await settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_A,
      workerSessionId: SESSION_B,
      actorUserId: null,
      settlementId: 'turn-1',
      reason: 'No evidence',
      measuredUsage: usage,
      now: new Date('2026-08-07T14:01:00.000Z'),
    });
    expect(first.action).toBe('continuation_queued');
    const lostResponseRetry = await settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_A,
      workerSessionId: SESSION_B,
      actorUserId: null,
      settlementId: 'turn-1',
      reason: 'No evidence',
      measuredUsage: usage,
      now: new Date('2026-08-07T14:01:01.000Z'),
    });
    expect(lostResponseRetry.action).toBe('continuation_queued');
    expect(lostResponseRetry.commandId).toBe(first.commandId);

    const second = await settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_A,
      workerSessionId: SESSION_B,
      actorUserId: null,
      settlementId: 'turn-2',
      reason: 'Still no evidence',
      measuredUsage: usage,
      now: new Date('2026-08-07T14:02:00.000Z'),
    });
    expect(second.action).toBe('blocked_escalation_queued');
    expect(second.task.status).toBe('blocked');
    expect(second.task.claimSessionId).toBeNull();
    expect(second.task.noProgressSettlements).toBe(2);
    await expect(settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_B,
      workerSessionId: SESSION_B,
      actorUserId: null,
      settlementId: 'turn-2',
      reason: 'Guessed retry',
      measuredUsage: usage,
      now: new Date('2026-08-07T14:02:01.000Z'),
    })).rejects.toBeInstanceOf(TaskLivenessConflictError);

    const commands = await database.select().from(sessionLifecycleCommands);
    expect(commands.filter((row) => row.idempotencyKey?.startsWith(`task-worker:${task.taskId}`))).toHaveLength(1);
    expect(commands.filter((row) => row.idempotencyKey?.startsWith(`task-no-progress:${task.taskId}`))).toHaveLength(1);
    expect(commands.filter((row) => row.idempotencyKey?.startsWith(`task-escalate:${task.taskId}`))).toHaveLength(1);
    expect(commands.filter((row) => row.idempotencyKey?.startsWith(`task-stop:${task.taskId}`))).toHaveLength(1);
  });

  test('iteration admission and usage sweeps atomically finalize exhausted workers', async () => {
    const database = testDb();
    const now = new Date('2026-08-07T16:00:00.000Z');
    const usage = {
      total_cost: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
      cache_write_tokens: 0, total_tokens: 0, request_count: 0,
    };
    async function boundedTask(origin: string, workerSessionId: string, contract: {
      max_wall_seconds: number; max_tokens: number; max_cost_usd: number; max_iterations: number;
    }) {
      const { task } = await createProjectTask(database, {
        projectId: PROJECT_ID, goalSlug: 'ship-kernel', title: origin, origin,
      });
      await claimProjectTask(database, {
        projectId: PROJECT_ID, taskId: task.taskId, sessionId: SESSION_A, now, leaseMs: 60_000,
      });
      await registerProjectTaskWorker(database, {
        projectId: PROJECT_ID, accountId: ACCOUNT_ID, taskId: task.taskId,
        claimSessionId: SESSION_A, workerSessionId, actorUserId: null,
        prompt: `Execute ${origin}`, contract, now,
      });
      return task;
    }

    const exhausted = await boundedTask('iteration-exhaustion', SESSION_B, {
      max_wall_seconds: 3_600, max_tokens: 1_000, max_cost_usd: 1, max_iterations: 1,
    });
    await admitProjectTaskWorkerIteration(database, { workerSessionId: SESSION_B, usage, now });
    await expect(admitProjectTaskWorkerIteration(database, {
      workerSessionId: SESSION_B, usage, now: new Date(now.getTime() + 1_000),
    })).rejects.toBeInstanceOf(TaskLivenessLimitExceededError);
    const exhaustedReadBack = await getProjectTask(database, { projectId: PROJECT_ID, taskId: exhausted.taskId });
    expect(exhaustedReadBack).toMatchObject({ status: 'blocked', claimSessionId: null });
    let commands = await database.select().from(sessionLifecycleCommands);
    expect(commands.filter((row) => row.idempotencyKey === `task-stop:${exhausted.taskId}:${SESSION_B}`)).toHaveLength(1);
    expect(commands.filter((row) => row.idempotencyKey === `task-bound-escalate:${exhausted.taskId}`)).toHaveLength(1);

    const concurrent = await boundedTask('concurrent-iteration-exhaustion', SESSION_C, {
      max_wall_seconds: 3_600, max_tokens: 1_000, max_cost_usd: 1, max_iterations: 1,
    });
    const admissions = await Promise.allSettled([
      admitProjectTaskWorkerIteration(database, { workerSessionId: SESSION_C, usage, now }),
      admitProjectTaskWorkerIteration(database, { workerSessionId: SESSION_C, usage, now }),
    ]);
    expect(admissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(admissions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await getProjectTask(database, { projectId: PROJECT_ID, taskId: concurrent.taskId }))
      .toMatchObject({ status: 'blocked', livenessIterationsAdmitted: 1 });

    const swept = await boundedTask('usage-sweep-exhaustion', SESSION_D, {
      max_wall_seconds: 3_600, max_tokens: 100, max_cost_usd: 10, max_iterations: 10,
    });
    const finalized = await sweepTaskLivenessBounds(database, new Date(now.getTime() + 1_000), 100, async () => ({
      ...usage, total_tokens: 101,
    }));
    expect(finalized).toBe(1);
    expect(await getProjectTask(database, { projectId: PROJECT_ID, taskId: swept.taskId }))
      .toMatchObject({ status: 'blocked', livenessBlocker: 'max_tokens exceeded' });
    commands = await database.select().from(sessionLifecycleCommands);
    expect(commands.filter((row) => row.idempotencyKey === `task-stop:${swept.taskId}:${SESSION_D}`)).toHaveLength(1);
  });

  test('goal observations reject non-finite values and query one metric range in time order', async () => {
    const database = testDb();
    const observations = [
      ['2026-08-07T12:02:00.000Z', 3],
      ['2026-08-07T12:00:00.000Z', 1],
      ['2026-08-07T12:01:00.000Z', 2],
    ] as const;
    for (const [observedAt, value] of observations) {
      await recordProjectGoalObservation(database, {
        projectId: PROJECT_ID,
        goalSlug: 'ship-kernel',
        metric: 'open_tasks',
        value,
        source: 'task-store',
        sessionId: SESSION_A,
        observedAt: new Date(observedAt),
      });
    }
    await recordProjectGoalObservation(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      metric: 'other_metric',
      value: 999,
      source: 'task-store',
      observedAt: new Date('2026-08-07T12:01:00.000Z'),
    });

    const rows = await listProjectGoalObservations(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      metric: 'open_tasks',
      from: new Date('2026-08-07T12:00:30.000Z'),
      to: new Date('2026-08-07T12:02:00.000Z'),
    });
    expect(rows.map(({ value }) => value)).toEqual([2, 3]);
    expect(rows.map(({ observedAt }) => observedAt.toISOString())).toEqual([
      '2026-08-07T12:01:00.000Z',
      '2026-08-07T12:02:00.000Z',
    ]);

    await expect(
      recordProjectGoalObservation(database, {
        projectId: PROJECT_ID,
        goalSlug: 'ship-kernel',
        metric: 'open_tasks',
        value: Number.POSITIVE_INFINITY,
        source: 'task-store',
        observedAt: new Date(),
      }),
    ).rejects.toThrow('value must be finite');

    const persisted = await database
      .select()
      .from(projectGoalObservations)
      .where(eq(projectGoalObservations.projectId, PROJECT_ID));
    expect(persisted).toHaveLength(4);
  });
});
