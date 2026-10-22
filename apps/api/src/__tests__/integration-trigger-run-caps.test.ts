/**
 * Integration test (real PostgreSQL): trigger run caps (KRTX-1721).
 *
 * A trigger starts at most `max_runs_per_hour` runs in any 60 minutes (60 when
 * unset) and at most `max_runs_per_day` in a UTC day. A fire past a cap starts
 * nothing: it is a skipped run whose reason names the cap, and the trigger's
 * watchers hear about it once that UTC day. A person's fire (manual, replay)
 * is never throttled. Session creation is stubbed; every query is real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, notifications, projectMembers, projectTriggerExecutions, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

// A create that ran would land here: a throttled fire must never reach it.
const creates: string[] = [];
const realSessions = await import('../projects/lib/sessions');
// The managed lineup is what Platinum Inference lists; tests never call
// Platinum, so seed the synthetic lineup (fixtures/managed-lineup.ts).
const { __setManagedLineupForTest } = await import('../llm-gateway/models/managed-models');
const { TEST_MANAGED_LINEUP } = await import('./fixtures/managed-lineup');
__setManagedLineupForTest(TEST_MANAGED_LINEUP);

mock.module('../projects/lib/sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: { metadata?: Record<string, unknown> }) => {
    creates.push(String(input.metadata?.trigger_slug));
    return { error: { status: 402, body: { error: 'stubbed create', code: 'insufficient_credits' } } };
  },
}));

const { drainTriggerExecutionQueue } = await import('../projects/lib/trigger-scheduler');
const { fireGitTrigger } = await import('../projects/lib/trigger-fire');
const { triggerRunCapReason, clearTriggerAutoPause } = await import('../projects/lib/trigger-run-caps');
const { claimDueScheduleSlots } = await import('../projects/trigger-execution-store');
const { setTriggerAlertNotifierForTest, settleTriggerAlerts } = await import('../projects/lib/trigger-alerts');
const { upsertTriggerWatcher } = await import('../projects/lib/trigger-watchers');
const { recordTriggerRun, triggerRunFromFire } = await import('../projects/trigger-execution-store');

const OWNER = crypto.randomUUID();
const WATCHER = crypto.randomUUID();
let project: SeededProject;

function spec(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name: `Trigger ${slug}`,
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    promptTemplate: 'Run it.',
    cron: '0 * * * * *',
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
    ...extra,
  } as const;
}

/** One run of `slug` `minutesAgo` before `now`, in `status`. */
async function seedRun(slug: string, now: Date, minutesAgo: number, status: 'succeeded' | 'requeued' | 'skipped' | 'failed' | 'rejected' = 'succeeded') {
  await recordTriggerRun({
    projectId: project.project_id,
    slug,
    source: 'webhook',
    spec: spec(slug),
    payload: {},
    status,
    error: status === 'skipped' ? 'deduped' : null,
    now: new Date(now.getTime() - minutesAgo * 60_000),
  });
}

async function seedTrigger(slug: string, triggerSpec: Record<string, unknown>) {
  await db.insert(projectTriggerRuntime).values({
    projectId: project.project_id,
    slug,
    triggerType: 'cron',
    enabled: true,
    scheduleRevision: 'c'.repeat(64),
    scheduleSpec: triggerSpec,
  });
}

/** One due cron slot of `slug`, as `claimDueScheduleSlots` writes it. */
async function seedDueSlot(slug: string, triggerSpec: Record<string, unknown>) {
  await db.insert(projectTriggerExecutions).values({
    projectId: project.project_id,
    slug,
    scheduleRevision: 'c'.repeat(64),
    scheduledFor: new Date(Date.now() - 60_000 - Math.floor(Math.random() * 1_000_000)),
    status: 'queued',
    spec: triggerSpec,
    payload: { trigger: { slug, type: 'cron', kind: 'git' } },
    availableAt: new Date(Date.now() - 1_000),
  });
}

async function slots(slug: string) {
  return db
    .select({ status: projectTriggerExecutions.status, lastError: projectTriggerExecutions.lastError, scheduleRevision: projectTriggerExecutions.scheduleRevision })
    .from(projectTriggerExecutions)
    .where(and(eq(projectTriggerExecutions.projectId, project.project_id), eq(projectTriggerExecutions.slug, slug), eq(projectTriggerExecutions.scheduleRevision, 'c'.repeat(64))));
}

async function alertsOf(slug: string) {
  return db
    .select({ userId: notifications.userId, kind: notifications.kind, body: notifications.body })
    .from(notifications)
    .where(and(eq(notifications.projectId, project.project_id), eq(notifications.triggerSlug, slug)));
}

async function projectRow() {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, project.project_id));
  return row!;
}

beforeAll(async () => {
  project = await seedProject('trigger-run-caps', { metadata: { experimental: { notification_center: true } } });
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: WATCHER, accountId: project.account_id, accountRole: 'member' },
  ]);
  // A watcher is told only while they may open the project.
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: WATCHER, projectRole: 'member' },
  ]);
  setTriggerAlertNotifierForTest({
    pushEnabled: true,
    listDevices: async () => [],
    sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }),
    emailAvailable: () => false,
  });
});

afterAll(async () => {
  setTriggerAlertNotifierForTest(null);
  await removeSeeded([project]);
});

describe('the cap verdict', () => {
  test('max_runs_per_hour counts the runs the trigger started in the last 60 minutes', async () => {
    const slug = 'hourly-window';
    const now = new Date('2026-10-19T12:00:00.000Z');
    await seedRun(slug, now, 10);
    await seedRun(slug, now, 50);
    // None of these started a run in the window.
    await seedRun(slug, now, 61);
    await seedRun(slug, now, 5, 'skipped');
    await seedRun(slug, now, 5, 'failed');
    await seedRun(slug, now, 5, 'rejected');
    await seedRun('another-trigger', now, 5);
    await seedRun('another-trigger', now, 6);
    await seedRun('another-trigger', now, 7);
    const caps = { maxRunsPerHour: 3 };
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps, now })).toBeNull();
    // A create that went back to the lifecycle queue still starts a run.
    await seedRun(slug, now, 1, 'requeued');
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps, now })).toBe(
      'throttled: 3 runs in the last hour (max_runs_per_hour 3)',
    );
    // The window rolls: an hour later only the requeued run is in it.
    const later = new Date(now.getTime() + 55 * 60_000);
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps, now: later })).toBeNull();
  });

  test('an unset max_runs_per_hour is 60', async () => {
    const slug = 'default-hourly';
    const now = new Date('2026-10-19T13:00:00.000Z');
    for (let i = 0; i < 59; i += 1) await seedRun(slug, now, (i % 59) + 0.5);
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps: {}, now })).toBeNull();
    await seedRun(slug, now, 0.1);
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps: {}, now })).toBe(
      'throttled: 60 runs in the last hour (max_runs_per_hour 60)',
    );
  });

  test('max_runs_per_day counts the runs since midnight UTC', async () => {
    const slug = 'daily-window';
    const now = new Date('2026-10-19T10:00:00.000Z');
    // 10.5 hours ago: yesterday, UTC.
    await seedRun(slug, now, 630);
    await seedRun(slug, now, 9 * 60);
    const caps = { maxRunsPerDay: 2 };
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps, now })).toBeNull();
    await seedRun(slug, now, 8 * 60);
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps, now })).toBe(
      'throttled: 2 runs today, UTC (max_runs_per_day 2)',
    );
    // The next UTC day starts empty.
    expect(await triggerRunCapReason({ projectId: project.project_id, slug, caps, now: new Date('2026-10-20T00:05:00.000Z') })).toBeNull();
  });
});

describe('a capped cron trigger (the real drain)', () => {
  const slug = 'capped-cron';
  const capped = spec(slug, { maxRunsPerHour: 1 });

  test('a slot past the cap is a skipped run with the reason, starts no session, and alerts the watcher', async () => {
    await seedTrigger(slug, capped);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: WATCHER });
    await seedRun(slug, new Date(), 5);
    await seedDueSlot(slug, capped);
    creates.length = 0;

    await drainTriggerExecutionQueue(new Date());
    await settleTriggerAlerts();

    expect(await slots(slug)).toEqual([
      expect.objectContaining({ status: 'skipped', lastError: 'throttled: 1 runs in the last hour (max_runs_per_hour 1)' }),
    ]);
    expect(creates).toEqual([]);
    expect(await alertsOf(slug)).toEqual([
      { userId: WATCHER, kind: 'automation_failed', body: 'throttled: 1 runs in the last hour (max_runs_per_hour 1)' },
    ]);
  });

  test('a second throttled slot the same UTC day alerts nobody again', async () => {
    await seedDueSlot(slug, capped);
    await drainTriggerExecutionQueue(new Date());
    await settleTriggerAlerts();

    expect((await slots(slug)).map((row) => row.status)).toEqual(['skipped', 'skipped']);
    expect(await alertsOf(slug)).toHaveLength(1);
    expect(creates).toEqual([]);
  });
});

describe('a fire by source', () => {
  const slug = 'capped-hook';
  const hook = spec(slug, { type: 'webhook', cron: null, secretEnv: 'CAPPED_HOOK_SECRET', maxRunsPerHour: 1 });

  test('a webhook fire past the cap answers skipped, and its run is a skipped run with the reason', async () => {
    await seedTrigger(slug, hook);
    await seedRun(slug, new Date(), 2);
    creates.length = 0;
    const result = await fireGitTrigger({ spec: hook as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'webhook' });
    expect(result).toEqual({ status: 'skipped', reason: 'throttled: 1 runs in the last hour (max_runs_per_hour 1)' });
    expect(triggerRunFromFire(result)).toEqual({
      status: 'skipped',
      sessionId: null,
      commandId: null,
      error: 'throttled: 1 runs in the last hour (max_runs_per_hour 1)',
    });
    expect(creates).toEqual([]);
  });

  test('a person firing it by hand is not throttled', async () => {
    creates.length = 0;
    const result = await fireGitTrigger({ spec: hook as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'manual', deliberate: true });
    expect(result.status).not.toBe('skipped');
    expect(creates).toEqual([slug]);
  });
});

async function autoPause(slug: string) {
  const [row] = await db
    .select({ at: projectTriggerRuntime.autoPausedAt, reason: projectTriggerRuntime.autoPausedReason, resumedAt: projectTriggerRuntime.autoPauseResumedAt })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
  return row;
}

// KRTX-1721: a trigger that ran at its hourly limit through the previous hour
// and is still held now is a runaway, not a burst. It pauses itself, tells its
// watchers once, and stays paused until someone resumes it.
describe('auto-pause (a sustained breach of max_runs_per_hour)', () => {
  const slug = 'runaway-hook';
  const hook = spec(slug, { type: 'webhook', cron: null, secretEnv: 'RUNAWAY_HOOK_SECRET', maxRunsPerHour: 1 });
  const paused = 'auto-paused: ran at max_runs_per_hour 1 for 2 hours in a row';

  test('at the limit through the previous hour and held now → auto-paused once, one alert, no session', async () => {
    await seedTrigger(slug, hook);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: WATCHER });
    await seedRun(slug, new Date(), 90);
    await seedRun(slug, new Date(), 5);
    creates.length = 0;

    const result = await fireGitTrigger({ spec: hook as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'webhook' });
    await settleTriggerAlerts();

    expect(result).toEqual({ status: 'skipped', reason: paused });
    expect(await autoPause(slug)).toEqual({ at: expect.any(Date), reason: paused, resumedAt: null });
    expect(await alertsOf(slug)).toEqual([{ userId: WATCHER, kind: 'automation_failed', body: paused }]);
    expect(creates).toEqual([]);
  });

  test('while auto-paused every automatic fire is skipped with the reason and no second alert; a person still fires it', async () => {
    const before = await autoPause(slug);
    const again = await fireGitTrigger({ spec: hook as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'webhook' });
    await settleTriggerAlerts();
    expect(again).toEqual({ status: 'skipped', reason: paused });
    expect(await autoPause(slug)).toEqual(before);
    expect(await alertsOf(slug)).toHaveLength(1);

    creates.length = 0;
    const manual = await fireGitTrigger({ spec: hook as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'manual', deliberate: true });
    expect(manual.status).not.toBe('skipped');
    expect(creates).toEqual([slug]);
  });

  test('resuming clears it; for 2 hours a held fire is a plain throttle, so old runs do not pause it again', async () => {
    expect(await clearTriggerAutoPause(project.project_id, slug)).toBe(true);
    expect(await autoPause(slug)).toEqual({ at: null, reason: null, resumedAt: expect.any(Date) });
    expect(await clearTriggerAutoPause(project.project_id, slug)).toBe(false);

    // The last 2 hours still hold the runaway's runs: held, not paused again.
    const held = await fireGitTrigger({ spec: hook as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'webhook' });
    expect(held).toEqual({ status: 'skipped', reason: 'throttled: 1 runs in the last hour (max_runs_per_hour 1)' });
    expect((await autoPause(slug))?.at).toBeNull();

    // A resume older than 2 hours no longer shields it.
    await db
      .update(projectTriggerRuntime)
      .set({ autoPauseResumedAt: new Date(Date.now() - 3 * 60 * 60_000) })
      .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
    const repaused = await fireGitTrigger({ spec: hook as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'webhook' });
    expect(repaused).toEqual({ status: 'skipped', reason: paused });
  });

  test('a throttle with room in the previous hour is a burst: held, not paused', async () => {
    const burst = 'bursty-hook';
    const bursty = spec(burst, { type: 'webhook', cron: null, secretEnv: 'BURSTY_HOOK_SECRET', maxRunsPerHour: 1 });
    await seedTrigger(burst, bursty);
    await seedRun(burst, new Date(), 5);
    const result = await fireGitTrigger({ spec: bursty as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: 'webhook' });
    expect(result).toEqual({ status: 'skipped', reason: 'throttled: 1 runs in the last hour (max_runs_per_hour 1)' });
    expect(await autoPause(burst)).toEqual({ at: null, reason: null, resumedAt: null });
  });

  test("an auto-paused cron trigger's due slot is not claimed; after resuming it is", async () => {
    const cron = 'paused-cron';
    await db.insert(projectTriggerRuntime).values({
      projectId: project.project_id,
      slug: cron,
      triggerType: 'cron',
      enabled: true,
      scheduleRevision: 'a'.repeat(64),
      scheduleSpec: spec(cron),
      nextFireAt: new Date(Date.now() - 30_000),
      autoPausedAt: new Date(),
      autoPausedReason: 'auto-paused: ran at max_runs_per_hour 1 for 2 hours in a row',
    });
    const claimed = (await claimDueScheduleSlots({ now: new Date(), limit: 50 })).map(({ execution }) => execution.slug);
    expect(claimed).not.toContain(cron);
    await clearTriggerAutoPause(project.project_id, cron);
    const after = (await claimDueScheduleSlots({ now: new Date(), limit: 50 })).map(({ execution }) => execution.slug);
    expect(after).toContain(cron);
  });
});
