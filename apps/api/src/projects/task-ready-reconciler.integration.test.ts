import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, accountTokens, accounts, createDb, projects } from '@kortix/db';
import {
  projectSessions,
  projectTaskEvents,
  projectTaskSessionLinks,
  projectTasks,
  sessionLifecycleCommands,
} from '@kortix/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  claimReadyTaskAndEnqueuePrompt,
  retireStaleReadyTaskCoordinator,
} from './session-lifecycle/store';
import { reconcileReadyProjectTasks } from './task-ready-reconciler';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.DATABASE_URL === process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000d701';
const PROJECT_ID = '00000000-0000-4000-a000-00000000d702';
const TASK_ID = '00000000-0000-4000-a000-00000000d703';
const DEPENDENCY_ID = '00000000-0000-4000-a000-00000000d704';
const USER_ID = '00000000-0000-4000-a000-00000000d705';
const AGI_SESSION_ID = 'ready-task-agi-coordinator';
const OTHER_AGI_SESSION_ID = 'ready-task-other-agi-coordinator';
const WRONG_AGENT_SESSION_ID = 'ready-task-wrong-agent';

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 4 });
  return integrationDb;
}

async function cleanup() {
  const database = testDb();
  // Delete task-owned append-only events before project deletion can apply
  // ON DELETE SET NULL to their session references.
  await database.delete(projectTasks).where(eq(projectTasks.projectId, PROJECT_ID));
  await database.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await database.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed() {
  const database = testDb();
  await database.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Ready task proof' });
  await database.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Ready task proof',
    repoUrl: 'https://example.test/ready-task.git',
    metadata: { experimental: { agi: true } },
  });
}

async function addSession(
  sessionId: string,
  agentName = 'agi',
  metadata: Record<string, unknown> = {},
) {
  await testDb().insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: sessionId,
    agentName,
    createdBy: USER_ID,
    metadata,
  });
}

async function addTask(taskId = TASK_ID, values: Partial<typeof projectTasks.$inferInsert> = {}) {
  await testDb()
    .insert(projectTasks)
    .values({
      taskId,
      projectId: PROJECT_ID,
      goalSlug: 'agi-v1',
      title: `Ready task ${taskId}`,
      status: 'todo',
      origin: 'test',
      ...values,
    });
}

describeWithDb('ready task reconciler — real PostgreSQL', () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  test('feature gate and dependencies prevent lifecycle command creation', async () => {
    const database = testDb();
    await addTask(DEPENDENCY_ID);
    await addTask(TASK_ID, { blockedBy: [DEPENDENCY_ID] });

    let result = await reconcileReadyProjectTasks({ database });
    expect(result.queued).toBe(1);
    let commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ agent_name: 'agi' }),
        postCreate: [expect.objectContaining({ taskId: DEPENDENCY_ID })],
      }),
    );

    await database
      .delete(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    await database
      .update(projectTasks)
      .set({ status: 'done' })
      .where(eq(projectTasks.taskId, DEPENDENCY_ID));
    await database
      .update(projects)
      .set({ metadata: { experimental: { agi: false } } })
      .where(eq(projects.projectId, PROJECT_ID));
    result = await reconcileReadyProjectTasks({ database });
    commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    expect(result.queued).toBe(0);
    expect(commands).toHaveLength(0);
  });

  test('a ready task queues one idempotent deterministic AGI create command', async () => {
    const database = testDb();
    await addTask();

    const first = await reconcileReadyProjectTasks({ database });
    const replay = await reconcileReadyProjectTasks({ database });
    const commands = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));

    expect(first.queued).toBe(1);
    expect(replay.deduped).toBe(1);
    expect(first.commandIds).toEqual(replay.commandIds);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.idempotencyKey).toMatch(
      new RegExp(`^task-ready:${PROJECT_ID}:${TASK_ID}:\\d+$`),
    );
    expect(commands[0]?.payload).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ agent_name: 'agi' }),
        postCreate: [
          expect.objectContaining({
            type: 'claim_ready_task',
            taskId: TASK_ID,
          }),
        ],
      }),
    );
  });

  test('post-create atomically claims the task, links the coordinator, and queues one prompt', async () => {
    const database = testDb();
    await addSession(AGI_SESSION_ID);
    await addTask();
    const now = new Date('2026-08-09T13:00:00.000Z');
    const input = {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: AGI_SESSION_ID,
      leaseSeconds: 900,
      prompt: 'Own this durable task.',
      now,
    };

    const first = await claimReadyTaskAndEnqueuePrompt(database, input);
    const replay = await claimReadyTaskAndEnqueuePrompt(database, input);
    const [task] = await database
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, PROJECT_ID), eq(projectTasks.taskId, TASK_ID)));
    const links = await database
      .select()
      .from(projectTaskSessionLinks)
      .where(eq(projectTaskSessionLinks.taskId, TASK_ID));
    const prompts = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));

    expect(first).toEqual(expect.objectContaining({ ok: true, deduped: false }));
    expect(replay).toEqual(expect.objectContaining({ ok: true, deduped: true }));
    expect(task).toEqual(
      expect.objectContaining({
        status: 'doing',
        claimSessionId: AGI_SESSION_ID,
        claimedAt: now,
        claimExpiresAt: new Date('2026-08-09T13:15:00.000Z'),
      }),
    );
    expect(links).toEqual([
      expect.objectContaining({
        sessionId: AGI_SESSION_ID,
        role: 'coordinator',
      }),
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual(
      expect.objectContaining({
        commandType: 'continue_session',
        source: 'system:task-ready-reconciler',
        sessionId: AGI_SESSION_ID,
        status: 'queued',
      }),
    );
    expect(events.filter((event) => event.eventType === 'task.status_changed')).toHaveLength(1);
  });

  test('a recovered todo task can bind a new coordinator and prompt generation', async () => {
    const database = testDb();
    await addSession(AGI_SESSION_ID);
    await addSession(OTHER_AGI_SESSION_ID);
    await addTask();
    const firstNow = new Date('2026-08-09T13:00:00.000Z');
    const secondNow = new Date('2026-08-09T14:00:00.000Z');

    expect(
      await claimReadyTaskAndEnqueuePrompt(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: AGI_SESSION_ID,
        leaseSeconds: 900,
        prompt: 'First coordinator prompt.',
        now: firstNow,
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
    await database
      .update(projectTasks)
      .set({
        status: 'todo',
        claimSessionId: null,
        claimedAt: null,
        claimExpiresAt: null,
        updatedAt: secondNow,
      })
      .where(eq(projectTasks.taskId, TASK_ID));

    expect(
      await claimReadyTaskAndEnqueuePrompt(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: OTHER_AGI_SESSION_ID,
        leaseSeconds: 900,
        prompt: 'Replacement coordinator prompt.',
        now: secondNow,
      }),
    ).toEqual(expect.objectContaining({ ok: true, deduped: false }));

    const prompts = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));
    expect(prompts).toHaveLength(2);
    expect(prompts.map((row) => row.sessionId).sort()).toEqual(
      [AGI_SESSION_ID, OTHER_AGI_SESSION_ID].sort(),
    );
  });

  test('a lost race is non-retryable and queues no prompt', async () => {
    const database = testDb();
    await addSession(AGI_SESSION_ID);
    await addSession(OTHER_AGI_SESSION_ID);
    const now = new Date('2026-08-09T13:00:00.000Z');
    await addTask(TASK_ID, {
      status: 'doing',
      claimSessionId: OTHER_AGI_SESSION_ID,
      claimedAt: now,
      claimExpiresAt: new Date('2026-08-09T14:00:00.000Z'),
    });

    const result = await claimReadyTaskAndEnqueuePrompt(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: AGI_SESSION_ID,
      leaseSeconds: 900,
      prompt: 'Must not be sent.',
      now,
    });
    const prompts = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'TASK_READY_STALE',
        retryable: false,
      }),
    );
    expect(prompts).toHaveLength(0);
  });

  test('retires a stale reconciler coordinator before returning control', async () => {
    const database = testDb();
    const retiredAt = new Date('2026-08-09T13:30:00.000Z');
    await addSession(AGI_SESSION_ID, 'agi', { task_ready_reconciler: true });
    await database.insert(accountTokens).values({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      sessionId: AGI_SESSION_ID,
      name: 'stale ready coordinator',
      publicKey: 'pub-stale-ready-coordinator',
      secretKeyHash: 'hash-stale-ready-coordinator',
    });

    await expect(
      retireStaleReadyTaskCoordinator(database, {
        projectId: PROJECT_ID,
        sessionId: AGI_SESSION_ID,
        reason: 'task lost its claim race',
        now: retiredAt,
      }),
    ).resolves.toBe(true);

    const [session] = await database
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, AGI_SESSION_ID));
    const [token] = await database
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.sessionId, AGI_SESSION_ID));
    const stops = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, AGI_SESSION_ID));
    expect(session).toMatchObject({
      status: 'stopped',
      metadata: expect.objectContaining({
        deletedAt: retiredAt.toISOString(),
        deletedBy: 'system:task-ready-reconciler',
      }),
    });
    expect(token).toMatchObject({ status: 'revoked', revokedAt: retiredAt });
    expect(stops).toEqual([
      expect.objectContaining({
        commandType: 'stop_session',
        source: 'system:task-ready-reconciler',
        status: 'queued',
      }),
    ]);
  });

  test('a non-AGI session cannot claim or receive the task prompt', async () => {
    const database = testDb();
    await addSession(WRONG_AGENT_SESSION_ID, 'builder');
    await addTask();

    const result = await claimReadyTaskAndEnqueuePrompt(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: WRONG_AGENT_SESSION_ID,
      leaseSeconds: 900,
      prompt: 'Must not be sent.',
    });
    const [task] = await database
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.taskId, TASK_ID));
    const prompts = await database
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.projectId, PROJECT_ID));

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'TASK_READY_STALE',
        retryable: false,
      }),
    );
    expect(task?.status).toBe('todo');
    expect(task?.claimSessionId).toBeNull();
    expect(prompts).toHaveLength(0);

    const missingSession = await claimReadyTaskAndEnqueuePrompt(database, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      sessionId: 'ready-task-missing-session',
      leaseSeconds: 900,
      prompt: 'Must not be sent.',
    });
    expect(missingSession).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'TASK_READY_STALE',
        retryable: false,
      }),
    );
  });
});
