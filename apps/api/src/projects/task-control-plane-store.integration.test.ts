import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, accounts, createDb, projects } from '@kortix/db';
import {
  accountTokens,
  projectSessions,
  projectTaskBlockers,
  projectTaskEvents,
  projectTaskEvidence,
  projectTaskMessages,
  projectTaskSessionLinks,
  projectTasks,
  sessionLifecycleCommands,
} from '@kortix/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  TaskClaimConflictError,
  type TaskCompletionGateError,
  claimProjectTask,
  registerProjectTaskWorker,
  requestProjectTaskCompletion,
} from './generated-state-store';
import {
  TaskControlPlaneConflictError,
  addProjectTaskEvidence,
  cancelProjectTask,
  createProjectTaskBlocker,
  currentProjectTaskForSession,
  proposeProjectTaskRefinement,
  resolveProjectTaskBlocker,
  reviseProjectTaskContract,
  rollbackProjectTaskRefinement,
  sweepDueProjectTaskBlockerReminders,
  sweepExpiredProjectTaskCoordinatorClaims,
} from './task-control-plane-store';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.DATABASE_URL === process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000b701';
const PROJECT_ID = '00000000-0000-4000-a000-00000000b702';
const TASK_ID = '00000000-0000-4000-a000-00000000b703';
const SESSION_ID = 'task-blocker-reminder-coordinator';
const HISTORICAL_SESSION_ID = 'task-blocker-reminder-old-coordinator';
const CANCELLATION_WORKER_SESSION_ID = 'task-cancellation-worker';
const BLOCKED_WORKER_SESSION_ID = 'task-blocked-old-worker';
const REQUEUED_WORKER_SESSION_ID = 'task-requeued-new-worker';
const SECOND_TASK_ID = '00000000-0000-4000-a000-00000000b705';
const USER_ID = '00000000-0000-4000-a000-00000000b704';

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 4 });
  return integrationDb;
}

async function cleanup() {
  const database = testDb();
  // Delete the task projection first. Deleting the project first would make
  // PostgreSQL apply ON DELETE SET NULL to append-only event session links.
  await database.delete(projectTasks).where(eq(projectTasks.projectId, PROJECT_ID));
  await database.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await database.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed() {
  const database = testDb();
  await database.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Blocker reminder proof' });
  await database.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Blocker reminder proof',
    repoUrl: 'https://example.test/blocker-reminder.git',
  });
  await database.insert(projectSessions).values({
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: 'blocker-reminder',
    agentName: 'kortix',
    createdBy: USER_ID,
  });
  await database.insert(projectTasks).values({
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    goalSlug: 'agi-v1',
    title: 'Obtain missing access',
    status: 'blocked',
    origin: 'test',
  });
  await database.insert(projectTaskSessionLinks).values({
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    role: 'coordinator',
  });
}

async function addHistoricalCoordinator(database: Database) {
  await database.insert(projectSessions).values({
    sessionId: HISTORICAL_SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: 'blocker-reminder-old',
    agentName: 'kortix',
    createdBy: USER_ID,
  });
  await database.insert(projectTaskSessionLinks).values({
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    sessionId: HISTORICAL_SESSION_ID,
    role: 'coordinator',
    createdAt: new Date('2026-08-09T10:00:00.000Z'),
  });
  await database
    .update(projectTaskSessionLinks)
    .set({ createdAt: new Date('2026-08-09T11:00:00.000Z') })
    .where(eq(projectTaskSessionLinks.sessionId, SESSION_ID));
}

async function seedCancellationWorker(database: Database, withActiveFences: boolean) {
  await database.insert(projectSessions).values({
    sessionId: CANCELLATION_WORKER_SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: CANCELLATION_WORKER_SESSION_ID,
    agentName: 'kortix',
    createdBy: USER_ID,
    metadata: { spawned_by_session: SESSION_ID },
  });
  await database.insert(accountTokens).values({
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    projectId: PROJECT_ID,
    sessionId: CANCELLATION_WORKER_SESSION_ID,
    name: 'cancellation worker',
    publicKey: 'pub-task-cancellation-worker',
    secretKeyHash: 'hash-task-cancellation-worker',
  });
  await database
    .update(projectTasks)
    .set({
      status: 'doing',
      claimSessionId: SESSION_ID,
      claimedAt: new Date('2026-08-09T13:00:00.000Z'),
      claimExpiresAt: new Date('2026-08-09T15:00:00.000Z'),
      livenessWorkerSessionId: CANCELLATION_WORKER_SESSION_ID,
      livenessCoordinatorSessionId: SESSION_ID,
      livenessWorkerContract: {
        max_wall_seconds: 3_600,
        max_tokens: 1_000,
        max_cost_usd: 1,
        max_iterations: 10,
      },
      livenessStartedAt: new Date('2026-08-09T13:00:00.000Z'),
      livenessDeadlineAt: new Date('2026-08-09T15:00:00.000Z'),
      livenessIterationsAdmitted: 1,
      ...(withActiveFences
        ? {
            livenessTurnId: '88888888-8888-4888-8888-888888888888',
            livenessAdmissionId: 'admission-cancel',
            livenessAdmissionExpiresAt: new Date('2026-08-09T13:30:00.000Z'),
            gitWriteRequestId: 'git-cancel',
            gitWriteLeaseExpiresAt: new Date('2026-08-09T13:30:00.000Z'),
            gitWriteState: 'live',
            gitWriteRef: `refs/heads/${CANCELLATION_WORKER_SESSION_ID}`,
            gitWriteOldOid: '1'.repeat(40),
            gitWriteNewOid: '2'.repeat(40),
          }
        : {}),
    })
    .where(eq(projectTasks.taskId, TASK_ID));
}

describeWithDb('task blocker reminder delivery', () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  test('advances the reminder and queues Review Center plus coordinator delivery once', async () => {
    const database = testDb();
    await addHistoricalCoordinator(database);
    const scheduledFor = new Date('2026-08-09T10:00:00.000Z');
    const now = new Date('2026-08-09T12:00:00.000Z');
    const [blocker] = await database
      .insert(projectTaskBlockers)
      .values({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        category: 'credential',
        requestedAction: 'Grant Google Workspace administrator access.',
        target: { service: 'google', reminder_interval_seconds: 3_600 },
        requestDigest: 'google-admin-v1',
        nextReminderAt: scheduledFor,
      })
      .returning();
    if (!blocker) throw new Error('blocker insert returned no row');

    expect(await sweepDueProjectTaskBlockerReminders(database, now, 10)).toEqual({
      reminded: 1,
      expired: 0,
      coordinatorWakes: 1,
    });
    await expect(sweepDueProjectTaskBlockerReminders(database, now, 10)).resolves.toEqual({
      reminded: 0,
      expired: 0,
      coordinatorWakes: 0,
    });

    const [updated] = await database
      .select()
      .from(projectTaskBlockers)
      .where(eq(projectTaskBlockers.blockerId, blocker.blockerId));
    expect(updated?.nextReminderAt?.toISOString()).toBe('2026-08-09T13:00:00.000Z');

    const messages = await database
      .select()
      .from(projectTaskMessages)
      .where(eq(projectTaskMessages.taskId, TASK_ID));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      recipientSessionId: SESSION_ID,
      messageType: 'blocker_reminder',
      status: 'queued',
    });

    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandType: 'continue_session',
      idempotencyKey: `blocker-reminder:${blocker.blockerId}:${scheduledFor.toISOString()}`,
      source: 'system:task-blocker-reminder',
      sessionId: SESSION_ID,
      status: 'queued',
    });
    expect(commands[0]?.payload).toMatchObject({
      messageId: expect.stringMatching(/^msg/),
    });

    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(
      events.filter((event) => event.eventType === 'task.blocker_reminder_queued'),
    ).toHaveLength(1);
  });

  test('defaults an omitted first reminder to 24 hours after blocker creation', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T12:00:00.000Z');
    const result = await createProjectTaskBlocker(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      category: 'credential',
      requestedAction: 'Grant access.',
      target: {},
      requestDigest: 'default-first-reminder-v1',
      attemptsMade: [],
      nextReminderAt: undefined,
      expiresAt: null,
      sessionId: SESSION_ID,
      now,
    });

    expect(result.created).toBe(true);
    expect(result.blocker.nextReminderAt?.toISOString()).toBe('2026-08-10T12:00:00.000Z');
  });

  test('concurrent duplicate blocker creation returns one open blocker and one event', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T12:00:00.000Z');
    const input = {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      category: 'credential',
      requestedAction: 'Grant the production credential.',
      target: { service: 'production' },
      requestDigest: 'concurrent-production-credential-v1',
      attemptsMade: [],
      nextReminderAt: null,
      expiresAt: null,
      sessionId: SESSION_ID,
      now,
    };

    const results = await Promise.all([
      createProjectTaskBlocker(database, input),
      createProjectTaskBlocker(database, input),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.blocker.blockerId)).size).toBe(1);
    expect(results[0]?.blocker.nextReminderAt).toBeNull();

    const blockers = await database
      .select()
      .from(projectTaskBlockers)
      .where(
        and(
          eq(projectTaskBlockers.taskId, TASK_ID),
          eq(projectTaskBlockers.requestDigest, input.requestDigest),
        ),
      );
    expect(blockers).toHaveLength(1);
    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(events.filter((event) => event.eventType === 'task.blocker_created')).toHaveLength(1);
  });

  test('expiry of the final blocker requeues the task and wakes the coordinator', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T12:00:00.000Z');
    const [blocker] = await database
      .insert(projectTaskBlockers)
      .values({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        category: 'approval',
        requestedAction: 'Approve the deployment.',
        requestDigest: 'deploy-approval-v1',
        nextReminderAt: null,
        expiresAt: new Date('2026-08-09T11:00:00.000Z'),
      })
      .returning();
    if (!blocker) throw new Error('blocker insert returned no row');

    await expect(sweepDueProjectTaskBlockerReminders(database, now, 10)).resolves.toEqual({
      reminded: 0,
      expired: 1,
      coordinatorWakes: 1,
    });
    const [updated] = await database
      .select()
      .from(projectTaskBlockers)
      .where(eq(projectTaskBlockers.blockerId, blocker.blockerId));
    expect(updated).toMatchObject({ status: 'expired', nextReminderAt: null });
    const [task] = await database
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(task).toMatchObject({ status: 'todo', livenessBlocker: null });
    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandType: 'continue_session',
      source: 'system:task-blocker-reminder',
      sessionId: SESSION_ID,
    });
    expect(commands[0]?.payload).toMatchObject({
      text: expect.stringContaining('is expired'),
      messageId: expect.stringMatching(/^msg/),
    });
  });

  test('resolving the final blocker requeues the task and wakes its coordinator', async () => {
    const database = testDb();
    await addHistoricalCoordinator(database);
    const [blocker] = await database
      .insert(projectTaskBlockers)
      .values({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        category: 'credential',
        requestedAction: 'Grant access.',
        requestDigest: 'credential-v1',
      })
      .returning();
    if (!blocker) throw new Error('blocker insert returned no row');
    const now = new Date('2026-08-09T12:00:00.000Z');

    await expect(
      resolveProjectTaskBlocker(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        blockerId: blocker.blockerId,
        now,
      }),
    ).resolves.toMatchObject({ status: 'resolved' });
    const [task] = await database
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, PROJECT_ID), eq(projectTasks.taskId, TASK_ID)));
    expect(task?.status).toBe('todo');
    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.sessionId).toBe(SESSION_ID);
    expect(commands[0]?.payload).toMatchObject({
      text: expect.stringContaining('is resolved'),
      messageId: expect.stringMatching(/^msg/),
    });
  });

  test('final blocker resolution clears the prior liveness attempt before a new worker binds', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T12:00:00.000Z');
    await database.insert(projectSessions).values([
      {
        sessionId: BLOCKED_WORKER_SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        branchName: BLOCKED_WORKER_SESSION_ID,
        agentName: 'kortix',
        createdBy: USER_ID,
        metadata: { spawned_by_session: SESSION_ID },
      },
      {
        sessionId: REQUEUED_WORKER_SESSION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        branchName: REQUEUED_WORKER_SESSION_ID,
        agentName: 'kortix',
        createdBy: USER_ID,
        metadata: {
          spawned_by_session: SESSION_ID,
          task_liveness_binding_required: 'true',
          task_liveness_binding_status: 'pending',
          task_liveness_reservation_expires_at: '2026-08-09T13:00:00.000Z',
        },
      },
    ]);
    await database.insert(projectTaskSessionLinks).values({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: BLOCKED_WORKER_SESSION_ID,
      role: 'worker',
      parentSessionId: SESSION_ID,
    });
    await database
      .update(projectTasks)
      .set({
        livenessWorkerSessionId: BLOCKED_WORKER_SESSION_ID,
        livenessCoordinatorSessionId: SESSION_ID,
        livenessWorkerContract: {
          max_wall_seconds: 3_600,
          max_tokens: 10_000,
          max_cost_usd: 5,
          max_iterations: 10,
        },
        livenessStartedAt: new Date('2026-08-09T10:00:00.000Z'),
        livenessDeadlineAt: new Date('2026-08-09T11:00:00.000Z'),
        livenessIterationsAdmitted: 2,
        livenessLastSweptAt: new Date('2026-08-09T10:30:00.000Z'),
        noProgressSettlements: 1,
        continuationConsumedAt: new Date('2026-08-09T10:20:00.000Z'),
        lastProgressAt: new Date('2026-08-09T10:10:00.000Z'),
        lastProgressRef: 'git://old-attempt',
        escalatedAt: new Date('2026-08-09T11:00:00.000Z'),
        livenessBlocker: 'credential missing',
      })
      .where(eq(projectTasks.taskId, TASK_ID));
    const [blocker] = await database
      .insert(projectTaskBlockers)
      .values({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        category: 'credential',
        requestedAction: 'Grant access.',
        requestDigest: 'stale-attempt-reset',
      })
      .returning();
    if (!blocker) throw new Error('blocker insert returned no row');

    await resolveProjectTaskBlocker(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      blockerId: blocker.blockerId,
      now,
    });
    let [task] = await database.select().from(projectTasks).where(eq(projectTasks.taskId, TASK_ID));
    expect(task).toMatchObject({
      status: 'todo',
      livenessWorkerSessionId: null,
      livenessCoordinatorSessionId: null,
      livenessWorkerContract: null,
      livenessIterationsAdmitted: 0,
      noProgressSettlements: 0,
      lastProgressRef: null,
      livenessBlocker: null,
    });
    const historicalLinks = await database
      .select()
      .from(projectTaskSessionLinks)
      .where(eq(projectTaskSessionLinks.taskId, TASK_ID));
    expect(historicalLinks.map((link) => link.sessionId)).toContain(BLOCKED_WORKER_SESSION_ID);

    await claimProjectTask(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      now: new Date('2026-08-09T12:00:01.000Z'),
      leaseMs: 60_000,
    });
    await expect(
      registerProjectTaskWorker(database, {
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        taskId: TASK_ID,
        claimSessionId: SESSION_ID,
        workerSessionId: REQUEUED_WORKER_SESSION_ID,
        actorUserId: USER_ID,
        prompt: 'Continue after the resolved blocker.',
        contract: {
          max_wall_seconds: 60,
          max_tokens: 10_000,
          max_cost_usd: 5,
          max_iterations: 10,
        },
        now: new Date('2026-08-09T12:00:02.000Z'),
      }),
    ).resolves.toMatchObject({
      existing: false,
      task: { livenessWorkerSessionId: REQUEUED_WORKER_SESSION_ID },
    });
    [task] = await database.select().from(projectTasks).where(eq(projectTasks.taskId, TASK_ID));
    expect(task?.livenessWorkerSessionId).toBe(REQUEUED_WORKER_SESSION_ID);
  });

  test('rejects contract revision during review and preserves the accepted revision', async () => {
    const database = testDb();
    await database
      .update(projectTasks)
      .set({
        status: 'review',
        intent: 'Accepted contract.',
        contractRevision: 3,
      })
      .where(eq(projectTasks.taskId, TASK_ID));

    await expect(
      reviseProjectTaskContract(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        intent: 'Invalid revised contract.',
        actorId: USER_ID,
        now: new Date('2026-08-09T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(TaskControlPlaneConflictError);
    const [task] = await database
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(task).toMatchObject({
      intent: 'Accepted contract.',
      contractRevision: 3,
    });
  });

  test('selects a live coordinator claim before newer historical lineage', async () => {
    const database = testDb();
    await database
      .update(projectTasks)
      .set({
        status: 'doing',
        claimSessionId: SESSION_ID,
        claimedAt: new Date('2026-08-09T11:00:00.000Z'),
        claimExpiresAt: new Date('2026-08-09T13:00:00.000Z'),
        updatedAt: new Date('2026-08-09T11:00:00.000Z'),
      })
      .where(eq(projectTasks.taskId, TASK_ID));
    await database.insert(projectTasks).values({
      taskId: SECOND_TASK_ID,
      projectId: PROJECT_ID,
      goalSlug: 'agi-v1',
      title: 'Historical task updated later',
      status: 'done',
      origin: 'test',
      updatedAt: new Date('2026-08-09T12:00:00.000Z'),
    });
    await database.insert(projectTaskSessionLinks).values({
      projectId: PROJECT_ID,
      taskId: SECOND_TASK_ID,
      sessionId: SESSION_ID,
      role: 'coordinator',
    });

    await expect(
      currentProjectTaskForSession(database, {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toMatchObject({ taskId: TASK_ID, status: 'doing' });
  });

  test('rejects blockers on terminal tasks without inserting blocker or event rows', async () => {
    const database = testDb();
    for (const status of ['done', 'cancelled'] as const) {
      await database.update(projectTasks).set({ status }).where(eq(projectTasks.taskId, TASK_ID));
      await expect(
        createProjectTaskBlocker(database, {
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          category: 'credential',
          requestedAction: 'Grant access.',
          target: {},
          requestDigest: `terminal-${status}`,
          attemptsMade: [],
          nextReminderAt: undefined,
          expiresAt: null,
          sessionId: null,
          now: new Date('2026-08-09T12:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(TaskControlPlaneConflictError);
    }
    expect(
      await database
        .select()
        .from(projectTaskBlockers)
        .where(eq(projectTaskBlockers.taskId, TASK_ID)),
    ).toHaveLength(0);
    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(events.filter((event) => event.eventType === 'task.blocker_created')).toHaveLength(0);
  });

  test('concurrent final blocker resolutions serialize to one requeue and one wake', async () => {
    const database = testDb();
    const blockers = await database
      .insert(projectTaskBlockers)
      .values([
        {
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          category: 'credential',
          requestedAction: 'Grant access A.',
          requestDigest: 'concurrent-resolution-a',
        },
        {
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          category: 'approval',
          requestedAction: 'Grant access B.',
          requestDigest: 'concurrent-resolution-b',
        },
      ])
      .returning();
    expect(blockers).toHaveLength(2);
    const now = new Date('2026-08-09T12:00:00.000Z');

    const results = await Promise.all(
      blockers.map((blocker) =>
        resolveProjectTaskBlocker(database, {
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          blockerId: blocker.blockerId,
          now,
        }),
      ),
    );
    expect(results).toHaveLength(2);
    expect(results.every((result) => result?.status === 'resolved')).toBe(true);

    const [task] = await database
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(task?.status).toBe('todo');
    const persistedBlockers = await database
      .select()
      .from(projectTaskBlockers)
      .where(eq(projectTaskBlockers.taskId, TASK_ID));
    expect(persistedBlockers.map((blocker) => blocker.status).sort()).toEqual([
      'resolved',
      'resolved',
    ]);
    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandType: 'continue_session',
      sessionId: SESSION_ID,
    });
  });

  test('refreshes the coordinator lineage timestamp when the task is reclaimed', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T12:00:00.000Z');
    await database
      .update(projectTaskSessionLinks)
      .set({ createdAt: new Date('2026-08-09T10:00:00.000Z') })
      .where(eq(projectTaskSessionLinks.sessionId, SESSION_ID));
    await database
      .update(projectTasks)
      .set({ status: 'todo', updatedAt: new Date('2026-08-09T11:00:00.000Z') })
      .where(eq(projectTasks.taskId, TASK_ID));

    await expect(
      claimProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        now,
        leaseMs: 60_000,
      }),
    ).resolves.toMatchObject({ status: 'doing', claimSessionId: SESSION_ID });

    const [link] = await database
      .select()
      .from(projectTaskSessionLinks)
      .where(eq(projectTaskSessionLinks.sessionId, SESSION_ID));
    expect(link?.createdAt.toISOString()).toBe(now.toISOString());
  });

  test('keeps the claim in review, rejects agent self-approval, and accepts later human approval', async () => {
    const database = testDb();
    await seedCancellationWorker(database, false);
    const candidateDigest = 'sha256:review-candidate';
    const claimExpiresAt = new Date('2026-08-09T15:00:00.000Z');
    await database
      .update(projectTasks)
      .set({
        status: 'doing',
        intent: 'Ship the verified change.',
        reviewPolicy: { mode: 'human' },
        verificationRequirements: [
          {
            id: 'tests',
            kind: 'command',
            description: 'Focused tests pass.',
            required: true,
          },
        ],
        claimSessionId: SESSION_ID,
        claimedAt: new Date('2026-08-09T12:00:00.000Z'),
        claimExpiresAt,
        livenessTurnId: '77777777-7777-4777-8777-777777777777',
      })
      .where(eq(projectTasks.taskId, TASK_ID));
    await database.insert(projectTaskEvidence).values({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      contractRevision: 1,
      requirementId: 'tests',
      kind: 'command',
      ref: 'test://focused',
      summary: 'Focused tests passed.',
      candidateDigest,
      state: 'passed',
    });

    const agentRequest = {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      expectedClaimSessionId: SESSION_ID,
      candidateDigest,
      humanReviewApproved: false,
      now: new Date('2026-08-09T12:05:00.000Z'),
    };
    await expect(requestProjectTaskCompletion(database, agentRequest)).rejects.toMatchObject({
      code: 'TASK_COMPLETION_GATE_UNMET',
      unmet: [{ code: 'HUMAN_REVIEW_REQUIRED' }],
    } satisfies Partial<TaskCompletionGateError>);
    let [task] = await database.select().from(projectTasks).where(eq(projectTasks.taskId, TASK_ID));
    expect(task).toMatchObject({
      status: 'review',
      claimSessionId: SESSION_ID,
      claimExpiresAt,
      livenessWorkerSessionId: CANCELLATION_WORKER_SESSION_ID,
      livenessTurnId: null,
      completedAt: null,
    });
    const [reviewWorkerToken] = await database
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.sessionId, CANCELLATION_WORKER_SESSION_ID));
    expect(reviewWorkerToken).toMatchObject({
      status: 'revoked',
      revokedAt: new Date('2026-08-09T12:05:00.000Z'),
    });
    let workerStopCommands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, CANCELLATION_WORKER_SESSION_ID));
    expect(workerStopCommands).toHaveLength(1);
    expect(workerStopCommands[0]).toMatchObject({
      commandType: 'stop_session',
      idempotencyKey: `task-stop:${TASK_ID}:${CANCELLATION_WORKER_SESSION_ID}`,
      payload: { reason: 'task_review_requested' },
    });

    await expect(
      requestProjectTaskCompletion(database, {
        ...agentRequest,
        now: new Date('2026-08-09T12:10:00.000Z'),
      }),
    ).rejects.toMatchObject({ unmet: [{ code: 'HUMAN_REVIEW_REQUIRED' }] });

    await database.insert(projectTasks).values({
      taskId: SECOND_TASK_ID,
      projectId: PROJECT_ID,
      goalSlug: 'agi-v1',
      title: 'A second ready task',
      status: 'todo',
      origin: 'test',
    });
    await expect(
      claimProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: SECOND_TASK_ID,
        sessionId: SESSION_ID,
        now: new Date('2026-08-09T13:00:00.000Z'),
        leaseMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(TaskClaimConflictError);

    await expect(
      requestProjectTaskCompletion(database, {
        ...agentRequest,
        humanReviewApproved: true,
        now: new Date('2026-08-09T16:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ status: 'done', claimSessionId: null });
    [task] = await database.select().from(projectTasks).where(eq(projectTasks.taskId, TASK_ID));
    expect(task?.completedAt?.toISOString()).toBe('2026-08-09T16:00:00.000Z');

    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(events.map((event) => event.eventType)).toContain('task.review_requested');
    workerStopCommands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, CANCELLATION_WORKER_SESSION_ID));
    expect(workerStopCommands).toHaveLength(1);
  });

  test('a goal-less task completes the claim, evidence, review, and server-gated lifecycle', async () => {
    const database = testDb();
    const candidateDigest = 'sha256:goal-less-candidate';
    const claimedAt = new Date('2026-08-09T17:00:00.000Z');
    await database
      .update(projectTasks)
      .set({
        goalSlug: null,
        status: 'todo',
        intent: 'Complete task-first work.',
        reviewPolicy: { mode: 'human' },
        verificationRequirements: [
          {
            id: 'tests',
            kind: 'command',
            description: 'Focused tests pass.',
            required: true,
          },
        ],
      })
      .where(eq(projectTasks.taskId, TASK_ID));

    await expect(
      claimProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        now: claimedAt,
        leaseMs: 60_000,
      }),
    ).resolves.toMatchObject({
      goalSlug: null,
      status: 'doing',
      claimSessionId: SESSION_ID,
    });

    await expect(
      addProjectTaskEvidence(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        requirementId: 'tests',
        kind: 'command',
        ref: 'command://goal-less-focused-tests',
        candidateDigest,
        state: 'passed',
        now: new Date('2026-08-09T17:00:10.000Z'),
      }),
    ).resolves.toMatchObject({
      contractRevision: 1,
      candidateDigest,
      state: 'passed',
    });

    await expect(
      requestProjectTaskCompletion(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        expectedClaimSessionId: SESSION_ID,
        candidateDigest,
        humanReviewApproved: false,
        now: new Date('2026-08-09T17:00:20.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'TASK_COMPLETION_GATE_UNMET',
      unmet: [{ code: 'HUMAN_REVIEW_REQUIRED' }],
    } satisfies Partial<TaskCompletionGateError>);

    await expect(
      requestProjectTaskCompletion(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        expectedClaimSessionId: SESSION_ID,
        candidateDigest,
        humanReviewApproved: true,
        now: new Date('2026-08-09T17:01:01.000Z'),
      }),
    ).resolves.toMatchObject({
      goalSlug: null,
      status: 'done',
      claimSessionId: null,
    });
  });

  test('rejects cancellation with active side-effect fences and preserves responsibility', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T14:00:00.000Z');
    await seedCancellationWorker(database, true);

    await expect(
      cancelProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        actorId: USER_ID,
        reason: 'The provider exhausted its start attempts.',
        now,
      }),
    ).rejects.toBeInstanceOf(TaskControlPlaneConflictError);

    const [task] = await database
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(task).toMatchObject({
      status: 'doing',
      claimSessionId: SESSION_ID,
      livenessWorkerSessionId: CANCELLATION_WORKER_SESSION_ID,
      livenessAdmissionId: 'admission-cancel',
      gitWriteRequestId: 'git-cancel',
      gitWriteState: 'live',
    });
    const [token] = await database
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.sessionId, CANCELLATION_WORKER_SESSION_ID));
    expect(token).toMatchObject({ status: 'active', revokedAt: null });
    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, CANCELLATION_WORKER_SESSION_ID));
    expect(commands).toHaveLength(0);
    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(events.some((event) => event.eventType === 'task.canceled')).toBe(false);
  });

  test('cancels an active task only after side-effect fences settle', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T14:00:00.000Z');
    await seedCancellationWorker(database, false);

    await expect(
      cancelProjectTask(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        actorId: USER_ID,
        reason: 'The provider exhausted its start attempts.',
        now,
      }),
    ).resolves.toMatchObject({
      status: 'cancelled',
      claimSessionId: null,
      claimExpiresAt: null,
      result: {
        canceled: {
          reason: 'The provider exhausted its start attempts.',
          at: '2026-08-09T14:00:00.000Z',
          actor_id: USER_ID,
        },
      },
      livenessWorkerSessionId: null,
      livenessCoordinatorSessionId: null,
      livenessAdmissionId: null,
      gitWriteRequestId: null,
    });

    const [token] = await database
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.sessionId, CANCELLATION_WORKER_SESSION_ID));
    expect(token).toMatchObject({ status: 'revoked', revokedAt: now });
    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, CANCELLATION_WORKER_SESSION_ID));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandType: 'stop_session',
      source: 'system:task-cancellation',
      payload: { reason: 'task_cancelled' },
    });
    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(events.find((event) => event.eventType === 'task.canceled')?.payload).toMatchObject({
      reason: 'The provider exhausted its start attempts.',
      worker_session_id: CANCELLATION_WORKER_SESSION_ID,
      authority_revoked: true,
    });
  });

  test('task-local refinements use compare-and-swap revisions and ordered rollback', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T17:00:00.000Z');
    const first = await proposeProjectTaskRefinement(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      scope: 'task',
      observation: 'Require adversarial review',
      baseRevision: '0',
      patch: { review: 'adversarial' },
      evidenceRefs: ['evidence://review-gap'],
      sessionId: SESSION_ID,
      now,
    });
    const second = await proposeProjectTaskRefinement(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      scope: 'task',
      observation: 'Require browser proof too',
      baseRevision: first.proposalId,
      patch: { review: 'adversarial', verifier: 'browser' },
      evidenceRefs: ['evidence://browser-gap'],
      sessionId: SESSION_ID,
      now: new Date(now.getTime() + 1_000),
    });

    await expect(
      proposeProjectTaskRefinement(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        scope: 'task',
        observation: 'Stale writer',
        baseRevision: first.proposalId,
        patch: { stale: true },
        evidenceRefs: [],
        sessionId: SESSION_ID,
        now: new Date(now.getTime() + 2_000),
      }),
    ).rejects.toBeInstanceOf(TaskControlPlaneConflictError);
    await expect(
      rollbackProjectTaskRefinement(database, {
        projectId: PROJECT_ID,
        proposalId: first.proposalId,
        now: new Date(now.getTime() + 3_000),
      }),
    ).rejects.toBeInstanceOf(TaskControlPlaneConflictError);

    await expect(
      rollbackProjectTaskRefinement(database, {
        projectId: PROJECT_ID,
        proposalId: second.proposalId,
        now: new Date(now.getTime() + 4_000),
      }),
    ).resolves.toMatchObject({ status: 'rolled_back' });
    const [afterSecondRollback] = await database
      .select({ result: projectTasks.result })
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(afterSecondRollback?.result).toMatchObject({
      harness_overrides: { review: 'adversarial' },
      harness_revision: first.proposalId,
    });

    await expect(
      rollbackProjectTaskRefinement(database, {
        projectId: PROJECT_ID,
        proposalId: first.proposalId,
        now: new Date(now.getTime() + 5_000),
      }),
    ).resolves.toMatchObject({ status: 'rolled_back' });
    const [afterFirstRollback] = await database
      .select({ result: projectTasks.result })
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(afterFirstRollback?.result).toMatchObject({
      harness_overrides: {},
      harness_revision: '0',
    });
  });

  test('task-local refinements reject an oversized patch before applying it', async () => {
    const database = testDb();
    await expect(
      proposeProjectTaskRefinement(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        scope: 'task',
        observation: 'Oversized override',
        baseRevision: '0',
        patch: { prompt: 'x'.repeat(17_000) },
        evidenceRefs: [],
        sessionId: SESSION_ID,
        now: new Date('2026-08-09T18:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(TaskControlPlaneConflictError);
    const [task] = await database
      .select({ result: projectTasks.result })
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(task?.result).toEqual({});
  });

  test('recovers one expired coordinator claim through the lifecycle outbox', async () => {
    const database = testDb();
    const now = new Date('2026-08-09T14:00:00.000Z');
    await database
      .update(projectTasks)
      .set({
        status: 'doing',
        claimSessionId: SESSION_ID,
        claimedAt: new Date('2026-08-09T12:00:00.000Z'),
        claimExpiresAt: new Date('2026-08-09T13:00:00.000Z'),
      })
      .where(eq(projectTasks.taskId, TASK_ID));

    await expect(sweepExpiredProjectTaskCoordinatorClaims(database, now, 10)).resolves.toBe(1);
    await expect(sweepExpiredProjectTaskCoordinatorClaims(database, now, 10)).resolves.toBe(0);
    const [task] = await database
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    expect(task).toMatchObject({
      status: 'todo',
      claimSessionId: null,
      claimExpiresAt: null,
    });
    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, SESSION_ID));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandType: 'continue_session',
      source: 'system:task-coordinator-recovery',
    });
    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(events.filter((event) => event.eventType === 'task.coordinator_recovered')).toHaveLength(
      1,
    );
  });
});
