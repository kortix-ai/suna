import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, accounts, createDb, projects } from '@kortix/db';
import { projectSessions, projectTaskEvents, projectTasks } from '@kortix/db/schema';
import { and, eq } from 'drizzle-orm';
import { releaseProjectTaskClaimForCompensation } from './task-claim-release-store';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.DATABASE_URL === process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c701';
const PROJECT_ID = '00000000-0000-4000-a000-00000000c702';
const TASK_ID = '00000000-0000-4000-a000-00000000c703';
const SESSION_ID = 'task-run-compensation-coordinator';
const WORKER_SESSION_ID = 'task-run-compensation-worker';
const USER_ID = '00000000-0000-4000-a000-00000000c704';
const NOW = new Date('2026-08-09T12:00:00.000Z');

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 2 });
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
  await database.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Run compensation' });
  await database.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Run compensation',
    repoUrl: 'https://example.test/run-compensation.git',
  });
  await database.insert(projectSessions).values({
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: 'run-compensation',
    agentName: 'agi',
    createdBy: USER_ID,
  });
  await database.insert(projectSessions).values({
    sessionId: WORKER_SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: 'run-compensation-worker',
    agentName: 'engineer',
    createdBy: USER_ID,
    metadata: { spawned_by_session: SESSION_ID },
  });
  await database.insert(projectTasks).values({
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    goalSlug: 'agi-v1',
    title: 'Compensate failed launch',
    status: 'doing',
    origin: 'test',
    claimSessionId: SESSION_ID,
    claimedAt: new Date('2026-08-09T11:59:00.000Z'),
    claimExpiresAt: new Date('2026-08-09T13:00:00.000Z'),
  });
}

describeWithDb('task run claim release compensation', () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  test('requeues the owned unused claim once and treats replay as success', async () => {
    const database = testDb();
    await expect(
      releaseProjectTaskClaimForCompensation(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ state: 'released', released: true });
    await expect(
      releaseProjectTaskClaimForCompensation(database, {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ state: 'already_released', released: false });

    const [task] = await database
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, PROJECT_ID), eq(projectTasks.taskId, TASK_ID)));
    expect(task).toMatchObject({
      status: 'todo',
      claimSessionId: null,
      claimedAt: null,
      claimExpiresAt: null,
    });
    const events = await database
      .select()
      .from(projectTaskEvents)
      .where(eq(projectTaskEvents.taskId, TASK_ID));
    expect(events.filter((event) => event.eventType === 'task.claim_released')).toHaveLength(1);
  });

  test('does not release another session claim', async () => {
    await expect(
      releaseProjectTaskClaimForCompensation(testDb(), {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: 'different-session',
        now: NOW,
      }),
    ).resolves.toEqual({ state: 'conflict' });
  });

  test('does not release a claim after bounded worker execution starts', async () => {
    await testDb()
      .update(projectTasks)
      .set({
        livenessWorkerSessionId: WORKER_SESSION_ID,
        livenessCoordinatorSessionId: SESSION_ID,
        livenessWorkerContract: {
          max_wall_seconds: 600,
          max_tokens: 1_000,
          max_cost_usd: 1,
          max_iterations: 4,
        },
        livenessStartedAt: new Date('2026-08-09T12:00:00.000Z'),
        livenessDeadlineAt: new Date('2026-08-09T12:10:00.000Z'),
      })
      .where(eq(projectTasks.taskId, TASK_ID));

    await expect(
      releaseProjectTaskClaimForCompensation(testDb(), {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ state: 'conflict' });
  });
});
