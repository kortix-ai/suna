import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  accounts,
  createDb,
  type Database,
  projectTriggerExecutions,
  projectTriggerRuntime,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import {
  claimDueScheduleSlots,
  claimTriggerExecutions,
  markTriggerExecutionFailed,
} from './trigger-execution-store';
import { triggerSchedulerIntervalMs } from './lib/triggers';
import type { GitTriggerSpec } from './triggers';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009801';
const PROJECT_ID = '00000000-0000-4000-a000-000000009802';
const SLUG = 'scheduler-exact-proof';
const REVISION = 'a'.repeat(64);

const spec: GitTriggerSpec = {
  slug: SLUG,
  path: 'kortix.yaml#triggers.scheduler-exact-proof',
  name: 'Scheduler exact proof',
  type: 'cron',
  agent: 'default',
  model: null,
  enabled: true,
  promptTemplate: 'Prove the schedule claim',
  cron: '* * * * * *',
  runAt: null,
  timezone: 'UTC',
  secretEnv: null,
  run: null,
  monitorMode: null,
  intervalSeconds: null,
  expectEventWithinSeconds: null,
  sessionMode: 'fresh',
  pinnedSessionId: null,
  sessionKey: null,
  filter: null,
};

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 4 });
  return integrationDb;
}

async function cleanup() {
  const db = testDb();
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed(nextFireAt: Date, metadata: Record<string, unknown> = {}) {
  const db = testDb();
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Scheduler exact proof' });
  await db.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Scheduler exact proof',
    repoUrl: 'https://example.test/scheduler-exact.git',
    metadata,
  });
  await db.insert(projectTriggerRuntime).values({
    projectId: PROJECT_ID,
    slug: SLUG,
    triggerType: 'cron',
    enabled: true,
    scheduleCron: spec.cron,
    scheduleTimezone: spec.timezone,
    scheduleRevision: REVISION,
    scheduleSpec: spec as unknown as Record<string, unknown>,
    nextFireAt,
  });
}

describeWithDb('durable exact trigger scheduler — real PostgreSQL', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test('concurrent scheduler pods claim one slot, coalesce backlog, and advance atomically', async () => {
    const scheduledFor = new Date('2026-07-27T01:00:00.000Z');
    const now = new Date('2026-07-27T01:05:00.250Z');
    await seed(scheduledFor);

    const claims = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        claimDueScheduleSlots({ now: new Date(now.getTime() + index), limit: 10 }),
      ),
    );
    expect(claims.flat()).toHaveLength(1);

    const db = testDb();
    const executions = await db
      .select()
      .from(projectTriggerExecutions)
      .where(
        and(
          eq(projectTriggerExecutions.projectId, PROJECT_ID),
          eq(projectTriggerExecutions.slug, SLUG),
        ),
      );
    expect(executions).toHaveLength(1);
    expect(executions[0]?.scheduledFor.toISOString()).toBe(scheduledFor.toISOString());
    expect(executions[0]?.claimedAt?.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(executions[0]?.claimedAt?.getTime()).toBeLessThan(now.getTime() + 16);

    const [runtime] = await db
      .select()
      .from(projectTriggerRuntime)
      .where(
        and(eq(projectTriggerRuntime.projectId, PROJECT_ID), eq(projectTriggerRuntime.slug, SLUG)),
      );
    expect(runtime?.lastScheduledFor?.toISOString()).toBe(scheduledFor.toISOString());
    expect(runtime?.nextFireAt?.getTime()).toBeGreaterThan(now.getTime());

    const duplicate = await claimDueScheduleSlots({ now, limit: 10 });
    expect(duplicate).toHaveLength(0);
  });

  test('execution leases are CAS-safe, retryable, reclaimable, and never stay stuck on final crash', async () => {
    const scheduledFor = new Date('2026-07-27T01:10:00.000Z');
    const now = new Date('2026-07-27T01:10:00.250Z');
    await seed(scheduledFor);
    await claimDueScheduleSlots({ now, limit: 10 });

    const concurrentClaims = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        claimTriggerExecutions({
          now: new Date(now.getTime() + 10),
          workerId: `worker-${index}`,
          limit: 1,
          leaseMs: 1_000,
        }),
      ),
    );
    const [first] = concurrentClaims.flat();
    expect(concurrentClaims.flat()).toHaveLength(1);
    expect(first?.attempts).toBe(1);
    if (!first) throw new Error('expected one claimed execution');

    const failedAt = new Date(now.getTime() + 20);
    expect(await markTriggerExecutionFailed({ row: first, failedAt, error: 'retry proof' })).toBe(
      'queued',
    );

    const db = testDb();
    await db
      .update(projectTriggerExecutions)
      .set({ availableAt: new Date(now.getTime() + 30) })
      .where(eq(projectTriggerExecutions.executionId, first.executionId));

    const [reclaimed] = await claimTriggerExecutions({
      now: new Date(now.getTime() + 40),
      workerId: 'retry-worker',
      limit: 1,
      leaseMs: 1_000,
    });
    expect(reclaimed?.attempts).toBe(2);
    if (!reclaimed) throw new Error('expected the failed execution to be reclaimed');

    await db
      .update(projectTriggerExecutions)
      .set({
        status: 'running',
        attempts: 5,
        lockedUntil: new Date(now.getTime() + 50),
      })
      .where(eq(projectTriggerExecutions.executionId, reclaimed.executionId));

    const exhausted = await claimTriggerExecutions({
      now: new Date(now.getTime() + 60),
      workerId: 'must-not-run',
      limit: 1,
    });
    expect(exhausted).toHaveLength(0);

    const [deadLetter] = await db
      .select()
      .from(projectTriggerExecutions)
      .where(eq(projectTriggerExecutions.executionId, reclaimed.executionId));
    expect(deadLetter?.status).toBe('dead_lettered');
    expect(deadLetter?.completedAt?.toISOString()).toBe(new Date(now.getTime() + 60).toISOString());
  });

  test('paused projects remain due but are not claimed or advanced', async () => {
    const scheduledFor = new Date('2026-07-27T01:20:00.000Z');
    const now = new Date('2026-07-27T01:20:00.500Z');
    await seed(scheduledFor, { triggers_paused: true });

    expect(await claimDueScheduleSlots({ now, limit: 10 })).toHaveLength(0);

    const db = testDb();
    const executions = await db
      .select()
      .from(projectTriggerExecutions)
      .where(eq(projectTriggerExecutions.projectId, PROJECT_ID));
    expect(executions).toHaveLength(0);

    const [runtime] = await db
      .select()
      .from(projectTriggerRuntime)
      .where(
        and(eq(projectTriggerRuntime.projectId, PROJECT_ID), eq(projectTriggerRuntime.slug, SLUG)),
      );
    expect(runtime?.nextFireAt?.toISOString()).toBe(scheduledFor.toISOString());
  });

  test('the live polling cadence claims a newly due slot within one scheduler interval', async () => {
    const intervalMs = triggerSchedulerIntervalMs();
    const scheduledFor = new Date(Date.now() + 200);
    await seed(scheduledFor);

    expect(await claimDueScheduleSlots({ now: new Date(), limit: 10 })).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const claimedAt = new Date();
    const claimed = await claimDueScheduleSlots({ now: claimedAt, limit: 10 });
    expect(claimed).toHaveLength(1);
    const lagMs = claimed[0]!.execution.claimedAt!.getTime() - scheduledFor.getTime();
    expect(lagMs).toBeGreaterThanOrEqual(0);
    expect(lagMs).toBeLessThan(intervalMs + 500);
  });
});
