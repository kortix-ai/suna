/**
 * Integration test (real PostgreSQL): a trigger that cannot run stops.
 *
 * Prod, 2026-11-02: one free project's cron triggers were pinned to models
 * the account could not use. Each slot was refused, retried four more times,
 * and dead-lettered, ~1,250 slots a day for a month; the project had no
 * notification center then, so nobody heard. A reuse trigger kept prompting its
 * session on a wallet at -$28, and the box billed every wake.
 *
 * The contract here, through the real cron drain and the real queries:
 * - a model refusal dead-letters on the first attempt;
 * - 24 hours in which every run failed with a refusal only the owner can fix
 *   (and at least 3 in a row) pause the trigger and tell its watchers; a
 *   resume starts a new 24 hours;
 * - a platform fault, an empty wallet, a shorter streak, or a run that worked
 *   never pauses it;
 * - a prompt into an existing session passes the billing gate.
 *
 * Session creation is a stub that refuses the model; everything else is real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, notifications, projectSessions, projectTriggerExecutions, projectTriggerRuntime, projects, sessionLifecycleCommands } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const MODEL_REFUSAL = 'Model "test/unavailable-model" is not available for this account';

const creates: string[] = [];
const realSessions = await import('../projects/lib/sessions');
// The fire's model gate reads the managed lineup; tests never call Platinum.
const { __setManagedLineupForTest } = await import('../llm-gateway/models/managed-models');
const { TEST_MANAGED_LINEUP } = await import('./fixtures/managed-lineup');
__setManagedLineupForTest(TEST_MANAGED_LINEUP);

mock.module('../projects/lib/sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: { metadata?: Record<string, unknown> }) => {
    creates.push(String(input.metadata?.trigger_slug));
    return { error: { status: 400, body: { error: MODEL_REFUSAL, code: 'INVALID_SESSION_MODEL' } } };
  },
}));

const { drainTriggerExecutionQueue } = await import('../projects/lib/trigger-scheduler');
const { fireGitTrigger } = await import('../projects/lib/trigger-fire');
const { recordTriggerRunEnd } = await import('../projects/lib/trigger-run-outcome');
const { clearTriggerAutoPause } = await import('../projects/lib/trigger-run-caps');
const { pauseTriggerIfAlwaysFailing } = await import('../projects/lib/trigger-failure-pause');
const { setTriggerAlertNotifierForTest, settleTriggerAlerts } = await import('../projects/lib/trigger-alerts');

const OWNER = crypto.randomUUID();
const HOUR = 60 * 60_000;
let project: SeededProject;
const emails: string[] = [];

function cronSpec(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name: `Trigger ${slug}`,
    type: 'cron',
    agent: 'default',
    model: 'test/unavailable-model',
    enabled: true,
    promptTemplate: 'Write the report.',
    cron: '0 0 * * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    sessionMode: 'fresh',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
    ...extra,
  };
}

async function seedTrigger(slug: string, spec: Record<string, unknown> = cronSpec(slug)) {
  await db.insert(projectTriggerRuntime).values({
    projectId: project.project_id,
    slug,
    triggerType: 'cron',
    enabled: true,
    scheduleRevision: 'a'.repeat(64),
    scheduleSpec: spec,
  });
}

/** One finished run of `slug`, `hoursAgo` hours ago. */
async function seedRun(
  slug: string,
  hoursAgo: number,
  run: { status: string; lastError?: string | null; runStatus?: string | null; runError?: string | null },
) {
  const at = new Date(Date.now() - hoursAgo * HOUR);
  await db.insert(projectTriggerExecutions).values({
    projectId: project.project_id,
    slug,
    scheduleRevision: 'a'.repeat(64),
    scheduledFor: at,
    status: run.status,
    lastError: run.lastError ?? null,
    runStatus: run.runStatus ?? null,
    runError: run.runError ?? null,
    spec: cronSpec(slug),
    payload: {},
    attempts: 1,
    createdAt: at,
    completedAt: at,
  });
}

const refused = (slug: string, hoursAgo: number) => seedRun(slug, hoursAgo, { status: 'dead_lettered', lastError: MODEL_REFUSAL });

/** One due slot, as `claimDueScheduleSlots` writes it. */
async function seedDueSlot(slug: string, spec: Record<string, unknown> = cronSpec(slug)) {
  await db.insert(projectTriggerExecutions).values({
    projectId: project.project_id,
    slug,
    scheduleRevision: 'a'.repeat(64),
    scheduledFor: new Date(Date.now() - 60_000 - Math.floor(Math.random() * 1_000_000)),
    status: 'queued',
    spec,
    payload: { trigger: { slug, type: 'cron', kind: 'git' } },
    availableAt: new Date(Date.now() - 1_000),
  });
}

async function drainCron() {
  await drainTriggerExecutionQueue(new Date());
  await settleTriggerAlerts();
}

async function runtimeOf(slug: string) {
  const [row] = await db
    .select({ at: projectTriggerRuntime.autoPausedAt, reason: projectTriggerRuntime.autoPausedReason })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
  return row!;
}

async function newestSlot(slug: string) {
  const [row] = await db
    .select({ status: projectTriggerExecutions.status, attempts: projectTriggerExecutions.attempts, lastError: projectTriggerExecutions.lastError })
    .from(projectTriggerExecutions)
    .where(and(eq(projectTriggerExecutions.projectId, project.project_id), eq(projectTriggerExecutions.slug, slug)))
    .orderBy(sql`${projectTriggerExecutions.createdAt} desc`)
    .limit(1);
  return row!;
}

async function alertRows(slug: string) {
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
  project = await seedProject('trigger-failure-pause');
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: project.account_id, accountRole: 'owner' }]);
  setTriggerAlertNotifierForTest({
    pushEnabled: true,
    listDevices: async () => [],
    sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }),
    emailAvailable: () => true,
    sendEmailNow: async ({ userId }) => {
      emails.push(userId);
      return 'sent';
    },
  });
});

afterAll(async () => {
  setTriggerAlertNotifierForTest(null);
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, project.project_id));
  await db.execute(sql`DELETE FROM kortix.credit_accounts WHERE account_id = ${project.account_id}::uuid`);
  await removeSeeded([project]);
});

describe('a slot refused for a model the account may not use', () => {
  test('dead-letters on the first attempt instead of retrying 4 more times', async () => {
    const slug = 'model-refused';
    await seedTrigger(slug);
    await seedDueSlot(slug);
    creates.length = 0;

    await drainCron();

    expect(await newestSlot(slug)).toEqual({ status: 'dead_lettered', attempts: 1, lastError: MODEL_REFUSAL });
    expect(creates).toEqual([slug]);
    // One refusal is no streak: the trigger keeps running.
    expect((await runtimeOf(slug)).at).toBeNull();
  });
});

describe('24 hours in which every run was refused', () => {
  const slug = 'always-refused';
  const reason = `auto-paused: every run failed for 24 hours: ${MODEL_REFUSAL}`;

  test('pause the trigger and tell its owner by inbox row and email', async () => {
    await seedTrigger(slug);
    await refused(slug, 30);
    await refused(slug, 20);
    await refused(slug, 10);
    await seedDueSlot(slug);
    emails.length = 0;

    await drainCron();

    expect(await newestSlot(slug)).toMatchObject({ status: 'dead_lettered', attempts: 1 });
    expect(await runtimeOf(slug)).toEqual({ at: expect.any(Date), reason });
    // The dead-lettered slot opens the fire streak (its email is opt-in), and
    // the pause tells the owner again, by email too.
    const rows = await alertRows(slug);
    expect(rows.map((row) => row.body).sort()).toEqual([MODEL_REFUSAL, reason]);
    expect(rows.every((row) => row.userId === OWNER && row.kind === 'automation_failed')).toBe(true);
    expect(emails).toEqual([OWNER]);
  });

  test('an automatic fire while paused is skipped with the reason and starts nothing', async () => {
    creates.length = 0;
    const result = await fireGitTrigger({ spec: cronSpec(slug) as never, project: await projectRow(), payload: {}, renderedPrompt: 'Write the report.', source: 'cron' });
    expect(result).toEqual({ status: 'skipped', reason });
    expect(creates).toEqual([]);
  });

  test('a resume starts a new 24 hours: the next refusal does not pause it again', async () => {
    expect(await clearTriggerAutoPause(project.project_id, slug)).toBe(true);
    await seedDueSlot(slug);
    await drainCron();

    expect(await newestSlot(slug)).toMatchObject({ status: 'dead_lettered', attempts: 1 });
    expect((await runtimeOf(slug)).at).toBeNull();
    // No new row: the fire streak the first refusal opened is still open.
    expect(await alertRows(slug)).toHaveLength(2);
  });
});

describe('what never pauses a trigger', () => {
  test('refusals that span less than 24 hours', async () => {
    const slug = 'short-streak';
    await seedTrigger(slug);
    await refused(slug, 20);
    await refused(slug, 10);
    await seedDueSlot(slug);
    await drainCron();
    expect((await runtimeOf(slug)).at).toBeNull();
  });

  test('fewer than 3 refusals in a row, however far apart', async () => {
    const slug = 'two-refusals';
    await seedTrigger(slug);
    await refused(slug, 30);
    await seedDueSlot(slug);
    await drainCron();
    expect((await runtimeOf(slug)).at).toBeNull();
  });

  test('a run that worked inside the 24 hours', async () => {
    const slug = 'worked-once';
    await seedTrigger(slug);
    await refused(slug, 30);
    await seedRun(slug, 12, { status: 'succeeded', runStatus: 'succeeded' });
    await refused(slug, 6);
    await seedDueSlot(slug);
    await drainCron();
    expect((await runtimeOf(slug)).at).toBeNull();
  });

  test('a platform fault or an empty wallet, for any length of time', async () => {
    const platform = 'drain failed: git clone timed out after 90000ms (signal SIGTERM)';
    const wallet = 'Out of credits. Top up or raise your plan to keep your agents running.';
    for (const [slug, error] of [['platform-fault', platform], ['empty-wallet', wallet]] as const) {
      await seedTrigger(slug);
      for (const hoursAgo of [40, 30, 20, 10, 1]) await seedRun(slug, hoursAgo, { status: 'dead_lettered', lastError: error });
      expect(await pauseTriggerIfAlwaysFailing({ projectId: project.project_id, slug, error })).toBe(false);
      expect((await runtimeOf(slug)).at).toBeNull();
    }
  });

  test('refusals whose streak began with a platform fault less than 24 hours of refusals ago', async () => {
    const slug = 'mixed-causes';
    await seedTrigger(slug);
    await seedRun(slug, 30, { status: 'dead_lettered', lastError: 'The sandbox provider is busy' });
    await refused(slug, 20);
    await refused(slug, 10);
    await refused(slug, 1);
    expect(await pauseTriggerIfAlwaysFailing({ projectId: project.project_id, slug, error: MODEL_REFUSAL })).toBe(false);
  });
});

describe('a run that keeps failing on the plan', () => {
  test("pauses the trigger at its run's end, with the provider's message as the reason", async () => {
    const slug = 'plan-refused-run';
    const runError = 'Run failed: 400: {"message":"\\"test/managed-model\\" requires a paid plan.","type":"plan_upgrade_required"}';
    await seedTrigger(slug, cronSpec(slug, { sessionMode: 'reuse', model: null }));
    for (const hoursAgo of [30, 20, 10, 1]) {
      await seedRun(slug, hoursAgo, { status: 'succeeded', runStatus: 'failed', runError });
    }
    const sessionId = await seedSession(project, OWNER);
    emails.length = 0;

    await recordTriggerRunEnd(
      {
        projectId: project.project_id,
        accountId: project.account_id,
        sessionId,
        metadata: { trigger_kind: 'git', trigger_slug: slug },
        status: 'error',
        error: { name: 'APIError', message: '400: {"message":"\\"test/managed-model\\" requires a paid plan.","type":"plan_upgrade_required"}' },
        outcome: 'closed',
        childSession: false,
      },
    );
    await settleTriggerAlerts();

    const reason = 'auto-paused: every run failed for 24 hours: "test/managed-model" requires a paid plan.';
    expect(await runtimeOf(slug)).toEqual({ at: expect.any(Date), reason });
    expect(emails).toEqual([OWNER]);
  });
});

describe('a reuse trigger on an empty wallet', () => {
  test('is refused before it prompts its session: dead-lettered at once, nothing queued', async () => {
    const slug = 'reuse-empty-wallet';
    const spec = cronSpec(slug, { sessionMode: 'reuse', model: null });
    await seedTrigger(slug, spec);
    const sessionId = await seedSession(project, OWNER);
    await db
      .update(projectSessions)
      .set({ status: 'stopped', metadata: { trigger_kind: 'git', trigger_slug: slug } })
      .where(eq(projectSessions.sessionId, sessionId));
    // A paid plan with an empty wallet: the billing gate refuses every run.
    await db.execute(sql`
      INSERT INTO kortix.credit_accounts (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
      VALUES (${project.account_id}::uuid, 0, 0, 0, 0, 'credits')`);
    await seedDueSlot(slug, spec);
    creates.length = 0;

    const billingWasEnabled = config.KORTIX_BILLING_INTERNAL_ENABLED;
    config.KORTIX_BILLING_INTERNAL_ENABLED = true;
    try {
      await drainCron();
    } finally {
      config.KORTIX_BILLING_INTERNAL_ENABLED = billingWasEnabled;
    }

    expect(await newestSlot(slug)).toEqual({
      status: 'dead_lettered',
      attempts: 1,
      lastError: 'Out of credits. Top up or raise your plan to keep your agents running.',
    });
    const prompts = await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, sessionId));
    expect(prompts).toEqual([]);
    expect(creates).toEqual([]);
  });
});
