import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, accounts, createDb, projects } from '@kortix/db';
import {
  accountTokens,
  projectGoalObservations,
  projectSessions,
  projectTaskNoProgressSettlements,
  projectTasks,
  sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db/schema';
import { eq } from 'drizzle-orm';
import {
  TaskClaimConflictError,
  TaskGitWriteInFlightError,
  TaskTransitionConflictError,
  TaskLivenessConflictError,
  TaskLivenessLimitExceededError,
  TaskWorkerReservationConflictError,
  acquireProjectTaskGitWrite,
  assertTaskWorkerReservationSlot,
  blockProjectTaskWorkerAdmission,
  admitProjectTaskWorkerIteration,
  claimProjectTask,
  createProjectTask,
  getProjectTask,
  listProjectGoalObservations,
  recordProjectGoalObservation,
  recordProjectTaskProgress,
  registerProjectTaskWorker,
  projectTaskWorkerIsBound,
  settleProjectTaskGitWrite,
  settleProjectTaskNoProgress,
  settleProjectTaskWorkerAdmission,
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
const SESSION_E = 'generated-state-session-e';
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
    },
    {
      sessionId: SESSION_C, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
      branchName: 'generated-state-c', agentName: 'reviewer', createdBy: USER_B,
    },
    {
      sessionId: SESSION_D, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
      branchName: 'generated-state-d', agentName: 'reviewer', createdBy: USER_B,
    },
    {
      sessionId: SESSION_E, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
      branchName: 'generated-state-e', agentName: 'reviewer', createdBy: USER_B,
    },
  ]);
}

async function reserveWorker(sessionId: string) {
  await testDb().update(projectSessions).set({
    status: 'queued',
    metadata: {
      spawned_by_session: SESSION_A,
      task_liveness_binding_required: true,
      task_liveness_binding_status: 'pending',
      task_liveness_reserved_at: '2026-08-07T13:59:00.000Z',
      task_liveness_reservation_expires_at: '2099-01-01T00:00:00.000Z',
    },
  }).where(eq(projectSessions.sessionId, sessionId));
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

    for (const [index, assigned] of [agentAssigned, userAssigned].entries()) {
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
      await transitionProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: assigned.task.taskId,
        status: 'done',
        expectedClaimSessionId: SESSION_A,
        now: new Date(now.getTime() + index + 1),
      });
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
      sessionId: SESSION_B,
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
      expectedClaimSessionId: SESSION_B,
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

  test('parallel reservation creation serializes to one non-provisioned child', async () => {
    const database = testDb();
    const now = new Date('2026-08-07T13:00:00.000Z');
    const childIds = ['parallel-reservation-a', 'parallel-reservation-b'];
    const attempts = await Promise.allSettled(childIds.map((sessionId) =>
      database.transaction(async (tx) => {
        await assertTaskWorkerReservationSlot(tx as unknown as Database, {
          projectId: PROJECT_ID,
          coordinatorSessionId: SESSION_A,
          now,
        });
        await tx.insert(projectSessions).values({
          sessionId,
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          branchName: sessionId,
          agentName: 'reviewer',
          createdBy: USER_B,
          status: 'queued',
          metadata: {
            spawned_by_session: SESSION_A,
            task_liveness_binding_required: true,
            task_liveness_binding_status: 'pending',
            task_liveness_reserved_at: now.toISOString(),
            task_liveness_reservation_expires_at: new Date(now.getTime() + 300_000).toISOString(),
          },
        });
      })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null)
      .toBeInstanceOf(TaskWorkerReservationConflictError);

    const rows = await database.select().from(projectSessions)
      .where(eq(projectSessions.projectId, PROJECT_ID));
    expect(rows.filter((row) =>
      (row.metadata as Record<string, unknown> | null)?.task_liveness_binding_required === true
    )).toHaveLength(1);
    expect(await database.select().from(sessionSandboxes)
      .where(eq(sessionSandboxes.projectId, PROJECT_ID))).toHaveLength(0);
    expect(await database.select().from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID))).toHaveLength(0);
  });

  test('spawned reservations cannot claim coordinator authority', async () => {
    const database = testDb();
    await reserveWorker(SESSION_B);
    const { task } = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Coordinator-only claim',
      origin: 'confinement-proof',
    });
    await expect(claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: task.taskId,
      sessionId: SESSION_B,
      now: new Date('2026-08-07T13:30:00.000Z'),
      leaseMs: 60_000,
    })).rejects.toBeInstanceOf(TaskClaimConflictError);
    expect(await getProjectTask(database, { projectId: PROJECT_ID, taskId: task.taskId }))
      .toMatchObject({ status: 'backlog', claimSessionId: null });
  });

  test('worker registration and one continuation survive retries and process restarts', async () => {
    const database = testDb();
    await Promise.all([reserveWorker(SESSION_B), reserveWorker(SESSION_C), reserveWorker(SESSION_D)]);
    // Three durable child reservations exist, but no runtime or lifecycle work
    // exists before one is atomically bound.
    expect(await database.select().from(sessionSandboxes)
      .where(eq(sessionSandboxes.projectId, PROJECT_ID))).toHaveLength(0);
    expect(await database.select().from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID))).toHaveLength(0);
    const reservations = await database.select().from(projectSessions);
    expect(reservations.filter((row) =>
      (row.metadata as Record<string, unknown> | null)?.task_liveness_binding_status === 'pending'
    )).toHaveLength(3);

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
    expect(registered.task.livenessDeadlineAt?.toISOString()).toBe('2026-08-07T15:00:00.000Z');
    expect(await database.select().from(sessionSandboxes)
      .where(eq(sessionSandboxes.projectId, PROJECT_ID))).toHaveLength(0);
    const registrationCommands = (await database.select().from(sessionLifecycleCommands))
      .filter((row) => row.sessionId === SESSION_B)
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime());
    expect(registrationCommands.map((row) => row.commandType)).toEqual([
      'provision_session',
      'continue_session',
    ]);
    expect(registrationCommands.map((row) => row.idempotencyKey)).toEqual([
      `task-worker-provision:${task.taskId}:${SESSION_B}`,
      `task-worker:${task.taskId}:${SESSION_B}`,
    ]);
    expect(registrationCommands[0].availableAt.getTime())
      .toBeLessThan(registrationCommands[1].availableAt.getTime());
    const [boundReservation] = await database.select().from(projectSessions)
      .where(eq(projectSessions.sessionId, SESSION_B));
    expect(boundReservation.status).toBe('queued');
    expect(boundReservation.metadata).toMatchObject({
      task_liveness_binding_status: 'bound',
      task_liveness_bound_task_id: task.taskId,
    });

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
    expect(retry.provisionCommandId).toBe(registered.provisionCommandId);
    const parallelRetries = await Promise.all(Array.from({ length: 4 }, () =>
      registerProjectTaskWorker(database, {
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        taskId: task.taskId,
        claimSessionId: SESSION_A,
        workerSessionId: SESSION_B,
        actorUserId: null,
        prompt: 'Do the bounded task.',
        contract,
        now: new Date('2026-08-07T14:00:01.500Z'),
      })));
    expect(new Set(parallelRetries.map((result) => result.commandId))).toEqual(new Set([registered.commandId]));
    expect(new Set(parallelRetries.map((result) => result.provisionCommandId)))
      .toEqual(new Set([registered.provisionCommandId]));
    expect((await database.select().from(sessionLifecycleCommands))
      .filter((row) => row.sessionId === SESSION_B)).toHaveLength(2);

    // PostgreSQL enforces that the coordinator claim cannot be shortened below
    // the immutable worker deadline.
    await expect(database.update(projectTasks).set({
      claimExpiresAt: new Date('2026-08-07T14:59:59.000Z'),
    }).where(eq(projectTasks.taskId, task.taskId))).rejects.toThrow();

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
      requestId: 'req-terminal-boundary',
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

    const priorSettlementReplay = await settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      taskId: task.taskId,
      claimSessionId: SESSION_A,
      workerSessionId: SESSION_B,
      actorUserId: null,
      settlementId: 'turn-1',
      reason: 'A replay cannot replace the original reason',
      measuredUsage: { ...usage, total_tokens: 999 },
      now: new Date('2026-08-07T14:02:01.000Z'),
    });
    expect(priorSettlementReplay).toMatchObject({
      action: 'continuation_queued',
      commandId: first.commandId,
      measuredUsage: usage,
      task: { status: 'doing', noProgressSettlements: 1, claimSessionId: SESSION_A },
    });
    expect(await getProjectTask(database, { projectId: PROJECT_ID, taskId: task.taskId }))
      .toEqual(second.task);
    expect(await database.select().from(projectTaskNoProgressSettlements)
      .where(eq(projectTaskNoProgressSettlements.taskId, task.taskId))).toHaveLength(2);

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

    await database.delete(projectTasks).where(eq(projectTasks.taskId, task.taskId));
    expect(await database.select().from(projectTaskNoProgressSettlements)
      .where(eq(projectTaskNoProgressSettlements.taskId, task.taskId))).toHaveLength(0);
  });

  test('worker registration rejects stopped sessions before queuing an initial prompt', async () => {
    const database = testDb();
    await reserveWorker(SESSION_B);
    const { task } = await createProjectTask(database, {
      projectId: PROJECT_ID, goalSlug: 'ship-kernel', title: 'Stopped worker', origin: 'stopped-worker-proof',
    });
    const now = new Date('2026-08-07T14:30:00.000Z');
    await claimProjectTask(database, {
      projectId: PROJECT_ID, taskId: task.taskId, sessionId: SESSION_A, now, leaseMs: 60_000,
    });
    await database.update(projectSessions).set({ status: 'stopped' }).where(eq(projectSessions.sessionId, SESSION_B));

    await expect(registerProjectTaskWorker(database, {
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, taskId: task.taskId,
      claimSessionId: SESSION_A, workerSessionId: SESSION_B, actorUserId: null,
      prompt: 'This must never run.',
      contract: { max_wall_seconds: 60, max_tokens: 1_000, max_cost_usd: 1, max_iterations: 1 },
      now,
    })).rejects.toBeInstanceOf(TaskLivenessConflictError);
    expect(await projectTaskWorkerIsBound(database, SESSION_B)).toBe(false);
    expect((await database.select().from(sessionLifecycleCommands))
      .filter((row) => row.sessionId === SESSION_B)).toHaveLength(0);
  });

  test('terminal task transitions retain the worker binding, queue its stop, and reject later admission', async () => {
    const database = testDb();
    await reserveWorker(SESSION_B);
    const { task } = await createProjectTask(database, {
      projectId: PROJECT_ID,
      goalSlug: 'ship-kernel',
      title: 'Terminal worker confinement',
      origin: 'worker-confinement-proof',
    });
    const now = new Date('2026-08-07T15:00:00.000Z');
    await claimProjectTask(database, {
      projectId: PROJECT_ID, taskId: task.taskId, sessionId: SESSION_A, now, leaseMs: 60_000,
    });
    await registerProjectTaskWorker(database, {
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, taskId: task.taskId,
      claimSessionId: SESSION_A, workerSessionId: SESSION_B, actorUserId: null,
      prompt: 'Complete this bounded task.',
      contract: { max_wall_seconds: 3_600, max_tokens: 1_000, max_cost_usd: 1, max_iterations: 2 },
      now,
    });

    const terminal = await transitionProjectTask(database, {
      projectId: PROJECT_ID, taskId: task.taskId, status: 'done',
      expectedClaimSessionId: SESSION_A, result: { evidence: [{ ref: 'proof' }] },
      now: new Date(now.getTime() + 1_000),
    });

    expect(terminal).toMatchObject({ status: 'done', livenessWorkerSessionId: SESSION_B });
    expect(await projectTaskWorkerIsBound(database, SESSION_B)).toBe(true);
    await expect(admitProjectTaskWorkerIteration(database, {
      workerSessionId: SESSION_B,
      requestId: 'req-terminal-confinement',
      usage: {
        total_cost: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
        cache_write_tokens: 0, total_tokens: 0, request_count: 0,
      },
      now: new Date(now.getTime() + 2_000),
    })).rejects.toBeInstanceOf(TaskLivenessLimitExceededError);
    const commands = await database.select().from(sessionLifecycleCommands);
    expect(commands.filter((row) => row.idempotencyKey === `task-stop:${task.taskId}:${SESSION_B}`)).toHaveLength(1);
  });

  test('iteration admission and usage sweeps atomically finalize exhausted workers', async () => {
    const database = testDb();
    await reserveWorker(SESSION_B);
    const now = new Date('2026-08-07T16:00:00.000Z');
    const usage = {
      total_cost: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
      cache_write_tokens: 0, total_tokens: 0, request_count: 0,
    };
    async function boundedTask(origin: string, workerSessionId: string, contract: {
      max_wall_seconds: number; max_tokens: number; max_cost_usd: number; max_iterations: number;
    }) {
      await reserveWorker(workerSessionId);
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
    await admitProjectTaskWorkerIteration(database, { workerSessionId: SESSION_B, requestId: 'req-iteration-first', usage, now });
    await settleProjectTaskWorkerAdmission(database, {
      workerSessionId: SESSION_B, admissionId: 'req-iteration-first', usage,
      now: new Date(now.getTime() + 500),
    });
    await expect(admitProjectTaskWorkerIteration(database, {
      workerSessionId: SESSION_B, requestId: 'req-iteration-second', usage, now: new Date(now.getTime() + 1_000),
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
      admitProjectTaskWorkerIteration(database, { workerSessionId: SESSION_C, requestId: 'req-concurrent-a', usage, now }),
      admitProjectTaskWorkerIteration(database, { workerSessionId: SESSION_C, requestId: 'req-concurrent-b', usage, now }),
    ]);
    expect(admissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(admissions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const concurrentWinner = admissions.find((result) => result.status === 'fulfilled');
    if (concurrentWinner?.status !== 'fulfilled' || !concurrentWinner.value) {
      throw new Error('concurrent admission winner missing');
    }
    await settleProjectTaskWorkerAdmission(database, {
      workerSessionId: SESSION_C,
      admissionId: concurrentWinner.value.admissionId,
      usage,
      now: new Date(now.getTime() + 500),
    });
    await expect(admitProjectTaskWorkerIteration(database, {
      workerSessionId: SESSION_C,
      requestId: 'req-concurrent-exhausted',
      usage,
      now: new Date(now.getTime() + 1_000),
    })).rejects.toBeInstanceOf(TaskLivenessLimitExceededError);
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

  test('every terminal path waits for receive-pack and revokes worker PATs transactionally', async () => {
    const database = testDb();
    const zeroUsage = {
      total_cost: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
      cache_write_tokens: 0, total_tokens: 0, request_count: 0,
    };

    async function bind(workerSessionId: string, origin: string, now: Date) {
      await reserveWorker(workerSessionId);
      const { task } = await createProjectTask(database, {
        projectId: PROJECT_ID, goalSlug: 'ship-kernel', title: origin, origin,
      });
      await claimProjectTask(database, {
        projectId: PROJECT_ID, taskId: task.taskId, sessionId: SESSION_A, now, leaseMs: 600_000,
      });
      await registerProjectTaskWorker(database, {
        projectId: PROJECT_ID, accountId: ACCOUNT_ID, taskId: task.taskId,
        claimSessionId: SESSION_A, workerSessionId, actorUserId: USER_A,
        prompt: origin,
        contract: { max_wall_seconds: 600, max_tokens: 1_000, max_cost_usd: 1, max_iterations: 10 },
        now,
      });
      await database.insert(accountTokens).values({
        accountId: ACCOUNT_ID,
        userId: USER_B,
        projectId: PROJECT_ID,
        sessionId: workerSessionId,
        name: `worker ${workerSessionId}`,
        publicKey: `pub-${workerSessionId}`,
        secretKeyHash: `hash-${workerSessionId}`,
      });
      return task;
    }

    async function tokenStatus(workerSessionId: string) {
      const [token] = await database.select({ status: accountTokens.status })
        .from(accountTokens).where(eq(accountTokens.sessionId, workerSessionId)).limit(1);
      return token?.status;
    }

    const transitionNow = new Date('2026-08-07T17:00:00.000Z');
    const transitioned = await bind(SESSION_B, 'terminal-transition-fence', transitionNow);
    const transitionLeases = await Promise.all(['git-transition-a', 'git-transition-b'].map(
      (requestId) => acquireProjectTaskGitWrite(database, {
        projectId: PROJECT_ID, workerSessionId: SESSION_B, requestId,
        now: new Date(transitionNow.getTime() + 1_000),
      }),
    ));
    expect(transitionLeases.filter(Boolean)).toHaveLength(1);
    const transitionRequestId = transitionLeases.find(Boolean)?.requestId;
    expect(transitionRequestId).toBeTruthy();
    await expect(transitionProjectTask(database, {
      projectId: PROJECT_ID, taskId: transitioned.taskId, status: 'done',
      expectedClaimSessionId: SESSION_A, result: { evidence: [{ ref: 'proof' }] },
      now: new Date(transitionNow.getTime() + 2_000),
    })).rejects.toBeInstanceOf(TaskGitWriteInFlightError);
    expect(await tokenStatus(SESSION_B)).toBe('active');
    expect(await settleProjectTaskGitWrite(database, {
      projectId: PROJECT_ID, workerSessionId: SESSION_B, requestId: 'wrong-request',
      now: new Date(transitionNow.getTime() + 3_000),
    })).toBe(false);
    expect(await settleProjectTaskGitWrite(database, {
      projectId: PROJECT_ID, workerSessionId: SESSION_B, requestId: transitionRequestId!,
      now: new Date(transitionNow.getTime() + 3_000),
    })).toBe(true);
    await transitionProjectTask(database, {
      projectId: PROJECT_ID, taskId: transitioned.taskId, status: 'done',
      expectedClaimSessionId: SESSION_A, result: { evidence: [{ ref: 'proof' }] },
      now: new Date(transitionNow.getTime() + 4_000),
    });
    expect(await tokenStatus(SESSION_B)).toBe('revoked');

    const noProgressNow = new Date('2026-08-07T18:00:00.000Z');
    const noProgress = await bind(SESSION_C, 'no-progress-fence', noProgressNow);
    await settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, taskId: noProgress.taskId,
      claimSessionId: SESSION_A, workerSessionId: SESSION_C, actorUserId: USER_A,
      settlementId: 'no-progress-first', reason: 'first', measuredUsage: zeroUsage,
      now: new Date(noProgressNow.getTime() + 1_000),
    });
    await acquireProjectTaskGitWrite(database, {
      projectId: PROJECT_ID, workerSessionId: SESSION_C, requestId: 'git-no-progress',
      now: new Date(noProgressNow.getTime() + 2_000),
    });
    await expect(settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, taskId: noProgress.taskId,
      claimSessionId: SESSION_A, workerSessionId: SESSION_C, actorUserId: USER_A,
      settlementId: 'no-progress-second', reason: 'second', measuredUsage: zeroUsage,
      now: new Date(noProgressNow.getTime() + 3_000),
    })).rejects.toBeInstanceOf(TaskGitWriteInFlightError);
    expect(await tokenStatus(SESSION_C)).toBe('active');
    await settleProjectTaskGitWrite(database, {
      projectId: PROJECT_ID, workerSessionId: SESSION_C, requestId: 'git-no-progress',
      now: new Date(noProgressNow.getTime() + 4_000),
    });
    await settleProjectTaskNoProgress(database, {
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, taskId: noProgress.taskId,
      claimSessionId: SESSION_A, workerSessionId: SESSION_C, actorUserId: USER_A,
      settlementId: 'no-progress-second', reason: 'second', measuredUsage: zeroUsage,
      now: new Date(noProgressNow.getTime() + 5_000),
    });
    expect(await tokenStatus(SESSION_C)).toBe('revoked');

    const ledgerNow = new Date('2026-08-07T19:00:00.000Z');
    await bind(SESSION_D, 'ledger-failure-fence', ledgerNow);
    const ledgerAdmission = await admitProjectTaskWorkerIteration(database, {
      workerSessionId: SESSION_D, requestId: 'ledger-admission', usage: zeroUsage, now: ledgerNow,
    });
    await acquireProjectTaskGitWrite(database, {
      projectId: PROJECT_ID, workerSessionId: SESSION_D, requestId: 'git-ledger',
      now: new Date(ledgerNow.getTime() + 1_000),
    });
    expect(await blockProjectTaskWorkerAdmission(database, {
      workerSessionId: SESSION_D, admissionId: ledgerAdmission!.admissionId,
      reason: 'ledger write failed', now: new Date(ledgerNow.getTime() + 2_000),
    })).toBe(false);
    expect(await tokenStatus(SESSION_D)).toBe('active');
    await settleProjectTaskGitWrite(database, {
      projectId: PROJECT_ID, workerSessionId: SESSION_D, requestId: 'git-ledger',
      now: new Date(ledgerNow.getTime() + 3_000),
    });
    expect(await blockProjectTaskWorkerAdmission(database, {
      workerSessionId: SESSION_D, admissionId: ledgerAdmission!.admissionId,
      reason: 'ledger write failed', now: new Date(ledgerNow.getTime() + 4_000),
    })).toBe(true);
    expect(await tokenStatus(SESSION_D)).toBe('revoked');

    const sweepNow = new Date('2026-08-07T20:00:00.000Z');
    await bind(SESSION_E, 'sweep-fence', sweepNow);
    await acquireProjectTaskGitWrite(database, {
      projectId: PROJECT_ID, workerSessionId: SESSION_E, requestId: 'git-sweep',
      now: new Date(sweepNow.getTime() + 1_000),
    });
    const loadExceededUsage = async () => ({ ...zeroUsage, total_tokens: 1_001 });
    expect(await sweepTaskLivenessBounds(
      database, new Date(sweepNow.getTime() + 2_000), 100, loadExceededUsage,
    )).toBe(0);
    expect(await tokenStatus(SESSION_E)).toBe('active');
    // Simulate a crashed proxy: no settlement arrives. The lease equals the
    // immutable worker deadline, so equality lets the wall-bound sweep finish.
    expect(await sweepTaskLivenessBounds(
      database, new Date(sweepNow.getTime() + 600_000), 100, loadExceededUsage,
    )).toBe(1);
    expect(await tokenStatus(SESSION_E)).toBe('revoked');
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
