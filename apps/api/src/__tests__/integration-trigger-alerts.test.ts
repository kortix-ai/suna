/**
 * Integration test (real PostgreSQL): automation alerts (KRTX-1742).
 *
 * A trigger that stops working tells the people who follow it, once per
 * failure streak, by inbox row and by email at once; it tells them once more
 * when it works again. Acceptance 7 runs through the real cron drain: a
 * scheduled fire into an account whose paid wallet is empty is refused by the
 * real billing gate with `insufficient_credits`, dead-letters at once, and
 * alerts the trigger's watcher, not the account owner. Session creation is
 * replaced by the billing gate alone (no git, model or sandbox step runs).
 * The senders are captured through the notifier seam; every query is real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  notifications,
  projectMembers,
  projectSessions,
  projectTriggerExecutions,
  projectTriggerRuntime,
  sessionLifecycleCommands,
  triggerWatchers,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { checkBillingAdmission } from '../billing/services/billing-gate';
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

// Every create this suite drives is refused by the real billing gate, before
// any git, model or sandbox step; the `transient-refusal` trigger's by a busy
// provider (a 503 the cron retries).
const realSessions = await import('../projects/lib/sessions');
mock.module('../projects/lib/sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: { project: { accountId: string }; metadata?: Record<string, unknown> }) => {
    if (input.metadata?.trigger_slug === 'transient-refusal') {
      return { error: { status: 503, body: { error: 'The sandbox provider is busy', code: 'provider_busy' } } };
    }
    const gate = await checkBillingAdmission(input.project.accountId);
    if (gate.ok) throw new Error('the alert suite drives only refused creates');
    return { error: { status: 402, body: { error: gate.message, code: gate.reason } } };
  },
}));

const { drainTriggerExecutionQueue } = await import('../projects/lib/trigger-scheduler');
const { drainSessionLifecycleQueue } = await import('../projects/session-lifecycle');
const { markGitTriggerFired } = await import('../projects/lib/trigger-fire');
const { recordTriggerRunEnd } = await import('../projects/lib/trigger-run-outcome');
const { setTriggerAlertNotifierForTest, settleTriggerAlerts } = await import('../projects/lib/trigger-alerts');
const { upsertTriggerWatcher } = await import('../projects/lib/trigger-watchers');
const { markCommandFailed } = await import('../projects/session-lifecycle/command-transitions');
const { markTriggerRuntimeDelivered } = await import('../projects/trigger-execution-store');

const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
/** An account member with no grant on the project: a creator who was demoted. */
const DEMOTED = crypto.randomUUID();

let project: SeededProject;
const emails: Array<{ userId: string; kind: NotificationKindName }> = [];
const billingWasEnabled = config.KORTIX_BILLING_INTERNAL_ENABLED;

function cronSpec(slug: string, name: string) {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name,
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    promptTemplate: 'Write the nightly report.',
    cron: '0 0 2 * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    sessionMode: 'fresh',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
    reminder: null,
  };
}

async function seedTrigger(slug: string, spec: Record<string, unknown> = cronSpec(slug, `Trigger ${slug}`), ownerUserId: string | null = null) {
  await db.insert(projectTriggerRuntime).values({
    projectId: project.project_id,
    slug,
    triggerType: 'cron',
    enabled: true,
    scheduleRevision: 'a'.repeat(64),
    scheduleSpec: spec,
    ownerUserId,
  });
}

/** One due slot of `slug`, as `claimDueScheduleSlots` would have written it. */
async function seedDueExecution(slug: string, spec: Record<string, unknown>) {
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

async function drainCron(): Promise<void> {
  await drainTriggerExecutionQueue(new Date());
  await settleTriggerAlerts();
}

async function alertRows(slug: string) {
  return db
    .select({ userId: notifications.userId, kind: notifications.kind, title: notifications.title, body: notifications.body, emailedAt: notifications.emailedAt })
    .from(notifications)
    .where(and(eq(notifications.projectId, project.project_id), eq(notifications.triggerSlug, slug)));
}

function usersOf(rows: Array<{ userId: string }>): string[] {
  return rows.map((row) => row.userId).sort();
}

beforeAll(async () => {
  project = await seedProject('trigger-alerts');
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: ADMIN, accountId: project.account_id, accountRole: 'admin' },
    { userId: MANAGER, accountId: project.account_id, accountRole: 'member' },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
    { userId: DEMOTED, accountId: project.account_id, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MANAGER, projectRole: 'manager' },
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  // A paid plan with an empty wallet: the billing gate refuses every run.
  await db.execute(sql`
    INSERT INTO kortix.credit_accounts (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
    VALUES (${project.account_id}::uuid, 0, 0, 0, 0, 'tier_2_20')`);
  config.KORTIX_BILLING_INTERNAL_ENABLED = true;
  setTriggerAlertNotifierForTest({
    pushEnabled: true,
    listDevices: async () => [],
    sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }),
    emailAvailable: () => true,
    sendEmailNow: async ({ userId, kind }) => {
      emails.push({ userId, kind });
      return 'sent';
    },
  });
});

afterAll(async () => {
  config.KORTIX_BILLING_INTERNAL_ENABLED = billingWasEnabled;
  setTriggerAlertNotifierForTest(null);
  await db.execute(sql`DELETE FROM kortix.credit_accounts WHERE account_id = ${project.account_id}::uuid`);
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, project.project_id));
  await removeSeeded([project]);
});

function emailsFor(kind: NotificationKindName): string[] {
  return emails.filter((email) => email.kind === kind).map((email) => email.userId).sort();
}

describe('a cron trigger that dead-letters on an empty wallet (acceptance 7)', () => {
  const slug = 'nightly-report';
  const spec = cronSpec(slug, 'Nightly report');

  test('alerts its watcher once by inbox row and email, and not the owner who does not watch it', async () => {
    await seedTrigger(slug, spec);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: MEMBER });
    await seedDueExecution(slug, spec);
    emails.length = 0;

    await drainCron();

    const [execution] = await db.select().from(projectTriggerExecutions).where(eq(projectTriggerExecutions.slug, slug));
    // Terminal on the first attempt: the billing refusal never retries.
    expect(execution).toMatchObject({ status: 'dead_lettered', attempts: 1 });
    // The inline create dead-lettered too; it alerted nobody a second time.
    const commands = await db
      .select({ status: sessionLifecycleCommands.status })
      .from(sessionLifecycleCommands)
      .where(and(eq(sessionLifecycleCommands.projectId, project.project_id), sql`${sessionLifecycleCommands.payload} -> 'metadata' ->> 'trigger_slug' = ${slug}`));
    expect(commands).toEqual([{ status: 'dead_lettered' }]);

    const rows = await alertRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: MEMBER, kind: 'automation_failed', title: 'Nightly report' });
    expect(rows[0]!.body).toBe(execution!.lastError!);
    expect(rows[0]!.emailedAt).not.toBeNull();
    expect(emailsFor('automation_failed')).toEqual([MEMBER]);
    expect(usersOf(rows)).not.toContain(OWNER);
  });

  test('a second dead letter in the same streak alerts nobody', async () => {
    await seedDueExecution(slug, spec);
    await drainCron();

    expect(await alertRows(slug)).toHaveLength(1);
    expect(emailsFor('automation_failed')).toEqual([MEMBER]);
  });

  test('the next good fire tells the watcher once that it works again', async () => {
    await markGitTriggerFired(project.project_id, slug, new Date());
    await markGitTriggerFired(project.project_id, slug, new Date());
    await settleTriggerAlerts();

    const recovered = (await alertRows(slug)).filter((row) => row.kind === 'automation_recovered');
    expect(usersOf(recovered)).toEqual([MEMBER]);
    // automation_recovered has email off by default.
    expect(emailsFor('automation_recovered')).toEqual([]);
    const [runtime] = await db.select().from(projectTriggerRuntime).where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
    expect(runtime).toMatchObject({ alertFailingSince: null, alertSource: null });
  });

  test('a queued fire does not end the streak; a new streak alerts again', async () => {
    await seedDueExecution(slug, spec);
    await drainCron();
    await markGitTriggerFired(project.project_id, slug, new Date(), 'queued');
    await settleTriggerAlerts();

    const rows = await alertRows(slug);
    expect(rows.filter((row) => row.kind === 'automation_failed')).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'automation_recovered')).toHaveLength(1);
  });
});

describe('who an alert reaches', () => {
  test('with no watcher left that may read the triggers, the project managers hear', async () => {
    const slug = 'demoted-creator';
    const spec = cronSpec(slug, 'Demoted creator');
    await seedTrigger(slug, spec);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: DEMOTED });
    await seedDueExecution(slug, spec);
    await drainCron();

    expect(usersOf(await alertRows(slug))).toEqual([ADMIN, MANAGER, OWNER].sort());
  });

  test('a watcher who muted it and can still see it keeps the managers out', async () => {
    const slug = 'muted-watcher';
    const spec = cronSpec(slug, 'Muted watcher');
    await seedTrigger(slug, spec);
    await db.insert(triggerWatchers).values({ projectId: project.project_id, slug, userId: MEMBER, muted: true });
    await seedDueExecution(slug, spec);
    await drainCron();

    expect(await alertRows(slug)).toEqual([]);
    const [runtime] = await db.select().from(projectTriggerRuntime).where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
    expect(runtime!.alertFailingSince).not.toBeNull();
  });

  test("a reminder's creator hears its dead letter; an owner who does not watch it does not", async () => {
    const slug = 'reminder.0a1b2c3d4e5f';
    const spec = {
      ...cronSpec(slug, 'Check the deploy'),
      sessionMode: 'pinned',
      // The session is gone: the fire pauses the reminder and dead-letters.
      pinnedSessionId: crypto.randomUUID(),
      reminder: { createdAt: new Date().toISOString() },
    };
    await seedTrigger(slug, spec, MEMBER);
    await seedDueExecution(slug, spec);
    await drainCron();

    const rows = await alertRows(slug);
    expect(usersOf(rows)).toEqual([MEMBER]);
    expect(rows[0]).toMatchObject({ kind: 'automation_failed', title: 'Check the deploy' });
  });

  test('an unnamed reminder is titled "Reminder", not by its id', async () => {
    const slug = 'reminder.9f8e7d6c5b4a';
    const spec = {
      ...cronSpec(slug, slug),
      sessionMode: 'pinned',
      pinnedSessionId: crypto.randomUUID(),
      reminder: { createdAt: new Date().toISOString() },
    };
    await seedTrigger(slug, spec, MEMBER);
    await seedDueExecution(slug, spec);
    await drainCron();

    expect(await alertRows(slug)).toMatchObject([{ userId: MEMBER, kind: 'automation_failed', title: 'Reminder' }]);
  });
});

describe('a failure the cron retries', () => {
  test('alerts nobody, though its inline create command dead-letters', async () => {
    const slug = 'transient-refusal';
    const spec = cronSpec(slug, 'Transient refusal');
    await seedTrigger(slug, spec);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: MEMBER });
    await seedDueExecution(slug, spec);
    await drainCron();

    const [execution] = await db.select().from(projectTriggerExecutions).where(eq(projectTriggerExecutions.slug, slug));
    expect(execution).toMatchObject({ status: 'queued', attempts: 1, lastError: 'The sandbox provider is busy' });
    const commands = await db
      .select({ status: sessionLifecycleCommands.status })
      .from(sessionLifecycleCommands)
      .where(sql`${sessionLifecycleCommands.payload} -> 'metadata' ->> 'trigger_slug' = ${slug}`);
    expect(commands).toEqual([{ status: 'dead_lettered' }]);
    expect(await alertRows(slug)).toEqual([]);
  });
});

describe('dead letters outside the cron attempt', () => {
  test('a create queued under backpressure that the lifecycle drain dead-letters alerts once', async () => {
    const slug = 'queued-create';
    await seedTrigger(slug);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: MEMBER });
    const queuedCreate = () => ({
      commandType: 'create_session',
      source: 'trigger:cron',
      status: 'queued' as const,
      projectId: project.project_id,
      accountId: project.account_id,
      actorUserId: OWNER,
      payload: {
        body: { initial_prompt: 'Write the nightly report.' },
        requestingPrincipalType: 'human',
        visibility: 'private',
        metadata: { trigger_source: 'cron', trigger_kind: 'git', trigger_slug: slug, trigger_type: 'cron' },
      },
      availableAt: new Date(Date.now() - 1_000),
    });
    await db.insert(sessionLifecycleCommands).values(queuedCreate());
    await drainSessionLifecycleQueue({ workerId: 'trigger-alerts-test', limit: 10 });
    await db.insert(sessionLifecycleCommands).values(queuedCreate());
    await drainSessionLifecycleQueue({ workerId: 'trigger-alerts-test', limit: 10 });
    await settleTriggerAlerts();

    const commands = await db
      .select({ status: sessionLifecycleCommands.status })
      .from(sessionLifecycleCommands)
      .where(sql`${sessionLifecycleCommands.payload} -> 'metadata' ->> 'trigger_slug' = ${slug}`);
    expect(commands).toEqual([{ status: 'dead_lettered' }, { status: 'dead_lettered' }]);
    const rows = await alertRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: MEMBER, kind: 'automation_failed' });
  });

  test("a trigger prompt the drain gives up on alerts; the next delivered prompt recovers", async () => {
    const slug = 'pinned-digest';
    await seedTrigger(slug);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: MEMBER });
    const [command] = await db
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'continue_session',
        source: 'trigger:cron',
        status: 'running',
        projectId: project.project_id,
        accountId: project.account_id,
        actorUserId: OWNER,
        payload: { text: 'Write the digest.', triggerSlug: slug },
        attempts: 5,
        lockedBy: 'session-lifecycle:drain-worker',
        lockedUntil: new Date(Date.now() + 60_000),
      })
      .returning();
    await markCommandFailed(command!, 'The session runtime did not answer', { retryable: true, attempts: 5 });
    await markTriggerRuntimeDelivered({ projectId: project.project_id, slug, when: new Date() });
    await settleTriggerAlerts();

    // Both deliveries run in the background: compare without their order.
    expect((await alertRows(slug)).map((row) => [row.userId, row.kind, row.body]).sort()).toEqual([
      [MEMBER, 'automation_failed', 'The session runtime did not answer'],
      [MEMBER, 'automation_recovered', ''],
    ]);
  });

  test('an execution whose final attempt lost its lease dead-letters on the next claim and alerts once', async () => {
    const slug = 'abandoned-run';
    const spec = cronSpec(slug, 'Abandoned run');
    await seedTrigger(slug, spec);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: MEMBER });
    await db.insert(projectTriggerExecutions).values({
      projectId: project.project_id,
      slug,
      scheduleRevision: 'a'.repeat(64),
      scheduledFor: new Date(Date.now() - 600_000),
      status: 'running',
      spec,
      payload: {},
      attempts: 5,
      lockedBy: 'a-dead-worker',
      lockedUntil: new Date(Date.now() - 1_000),
    });
    await drainCron();

    const [execution] = await db.select().from(projectTriggerExecutions).where(eq(projectTriggerExecutions.slug, slug));
    expect(execution!.status).toBe('dead_lettered');
    const rows = await alertRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: MEMBER, kind: 'automation_failed', body: 'execution lease expired after the maximum number of attempts' });
  });
});

describe('a run failure streak', () => {
  test('clears on the next finished run, never on a fire', async () => {
    const slug = 'run-failure';
    await seedTrigger(slug);
    await upsertTriggerWatcher({ accountId: project.account_id, projectId: project.project_id, slug, userId: MEMBER });
    const sessionId = crypto.randomUUID();
    const metadata = { trigger_kind: 'git', trigger_slug: slug, trigger_source: 'cron', trigger_type: 'cron' };
    await db.insert(projectSessions).values({
      sessionId,
      accountId: project.account_id,
      projectId: project.project_id,
      branchName: `trigger-${sessionId.slice(0, 8)}`,
      createdBy: OWNER,
      metadata,
    });
    const end = (status: 'idle' | 'error') => ({
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      metadata,
      status,
      error: status === 'error' ? { name: 'UnknownError', message: 'socket hang up' } : null,
      outcome: 'closed' as const,
      childSession: false,
    });

    await recordTriggerRunEnd(end('error'));
    await recordTriggerRunEnd(end('error'));
    await markGitTriggerFired(project.project_id, slug, new Date());
    await settleTriggerAlerts();
    expect((await alertRows(slug)).map((row) => row.kind)).toEqual(['automation_failed']);
    expect((await alertRows(slug))[0]!.body).toBe('Provider unavailable: socket hang up');

    await recordTriggerRunEnd(end('idle'));
    await recordTriggerRunEnd(end('idle'));
    await settleTriggerAlerts();
    expect((await alertRows(slug)).map((row) => row.kind).sort()).toEqual(['automation_failed', 'automation_recovered']);
  });
});
