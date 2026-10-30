/**
 * Integration test (real PostgreSQL): Pause all automations (KRTX-1721).
 *
 * One switch per account stops every automatic fire in every project of the
 * account. Proves: the switch records when and who, and resuming clears it; a
 * due schedule slot (and a reminder, which is a schedule row) of a paused
 * account is not claimed while another account's is, and resuming claims the
 * missed slot once; a slot already queued when the account pauses is skipped
 * by the drain and starts nothing; an App event is skipped with the reason.
 * Session creation is stubbed; every query is real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { projectMonitorEvents, projectTriggerExecutions, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const creates: string[] = [];
const realSessions = await import('../projects/lib/sessions');
mock.module('../projects/lib/sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: { metadata?: Record<string, unknown> }) => {
    creates.push(String(input.metadata?.trigger_slug));
    return { error: { status: 402, body: { error: 'stubbed create', code: 'insufficient_credits' } } };
  },
}));

const { readAccountAutomationPause, setAccountAutomationsPaused, ACCOUNT_AUTOMATIONS_PAUSED_REASON } = await import('../accounts/automation-pause');
const { claimDueScheduleSlots } = await import('../projects/trigger-execution-store');
const { drainTriggerExecutionQueue } = await import('../projects/lib/trigger-scheduler');
const { processMonitorEvent } = await import('../projects/lib/monitor-observer');

const PERSON = crypto.randomUUID();
let paused: SeededProject;
let running: SeededProject;

function cronSpec(slug: string) {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name: slug,
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    promptTemplate: 'Run it.',
    cron: '0 0 * * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    sessionMode: 'fresh',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
  };
}

async function seedDueCron(where: SeededProject, slug: string) {
  await db.insert(projectTriggerRuntime).values({
    projectId: where.project_id,
    slug,
    triggerType: 'cron',
    enabled: true,
    scheduleRevision: 'p'.repeat(64),
    scheduleSpec: cronSpec(slug),
    nextFireAt: new Date(Date.now() - 30_000),
  });
}

/** A due session reminder: a schedule row with `reminder` set, claimable while the project has the `reminders` flag. */
async function seedDueReminder(where: SeededProject, slug: string) {
  await db.update(projects).set({ metadata: { experimental: { reminders: true } } }).where(eq(projects.projectId, where.project_id));
  await db.insert(projectTriggerRuntime).values({
    projectId: where.project_id,
    slug,
    triggerType: 'cron',
    enabled: true,
    scheduleRevision: 'r'.repeat(64),
    scheduleSpec: {
      ...cronSpec(slug),
      sessionMode: 'pinned',
      pinnedSessionId: crypto.randomUUID(),
      reminder: { everySeconds: 3600, createdAt: new Date().toISOString() },
    },
    nextFireAt: new Date(Date.now() - 30_000),
  });
}

beforeAll(async () => {
  paused = await seedProject('automation-pause');
  running = await seedProject('automation-running');
});

afterAll(async () => {
  await removeSeeded([paused, running]);
});

describe('the switch', () => {
  test('pausing records when and who; pausing again keeps the first; resuming clears both', async () => {
    expect(await readAccountAutomationPause(paused.account_id)).toBeNull();
    const first = await setAccountAutomationsPaused({ accountId: paused.account_id, paused: true, userId: PERSON });
    expect(first?.pausedBy).toBe(PERSON);
    expect(first?.pausedAt).toBeInstanceOf(Date);
    const again = await setAccountAutomationsPaused({ accountId: paused.account_id, paused: true, userId: crypto.randomUUID() });
    expect(again).toEqual(first);
    expect(await setAccountAutomationsPaused({ accountId: paused.account_id, paused: false, userId: PERSON })).toBeNull();
    expect(await readAccountAutomationPause(paused.account_id)).toBeNull();
  });
});

describe('a paused account', () => {
  test('its due schedule slot and reminder are not claimed, another account’s are, and resuming claims each missed slot once', async () => {
    await seedDueCron(paused, 'paused-nightly');
    await seedDueReminder(paused, 'reminder.0a0a0a0a0a0a');
    await seedDueCron(running, 'running-nightly');
    await seedDueReminder(running, 'reminder.0b0b0b0b0b0b');
    await setAccountAutomationsPaused({ accountId: paused.account_id, paused: true, userId: PERSON });

    const claimed = await claimDueScheduleSlots({ now: new Date(), limit: 50 });
    const mine = claimed.map(({ execution }) => `${execution.projectId}:${execution.slug}`);
    expect(mine).toContain(`${running.project_id}:running-nightly`);
    expect(mine).toContain(`${running.project_id}:reminder.0b0b0b0b0b0b`);
    expect(mine).not.toContain(`${paused.project_id}:paused-nightly`);
    expect(mine).not.toContain(`${paused.project_id}:reminder.0a0a0a0a0a0a`);

    await setAccountAutomationsPaused({ accountId: paused.account_id, paused: false, userId: PERSON });
    const after = (await claimDueScheduleSlots({ now: new Date(), limit: 50 })).filter(({ execution }) => execution.projectId === paused.project_id);
    expect(after.map(({ execution }) => execution.slug).sort()).toEqual(['paused-nightly', 'reminder.0a0a0a0a0a0a']);
  });

  test('a slot already queued when the account pauses is skipped by the drain with the reason, and starts nothing', async () => {
    await db.delete(projectTriggerExecutions).where(eq(projectTriggerExecutions.projectId, paused.project_id));
    await db.insert(projectTriggerExecutions).values({
      projectId: paused.project_id,
      slug: 'queued-before-pause',
      scheduleRevision: 'q'.repeat(64),
      scheduledFor: new Date(Date.now() - 60_000),
      status: 'queued',
      spec: cronSpec('queued-before-pause'),
      payload: { trigger: { slug: 'queued-before-pause', type: 'cron', kind: 'git' } },
      availableAt: new Date(Date.now() - 1_000),
    });
    await setAccountAutomationsPaused({ accountId: paused.account_id, paused: true, userId: PERSON });
    creates.length = 0;

    await drainTriggerExecutionQueue(new Date());

    const [row] = await db
      .select({ status: projectTriggerExecutions.status, lastError: projectTriggerExecutions.lastError })
      .from(projectTriggerExecutions)
      .where(and(eq(projectTriggerExecutions.projectId, paused.project_id), eq(projectTriggerExecutions.slug, 'queued-before-pause')));
    expect(row).toEqual({ status: 'skipped', lastError: ACCOUNT_AUTOMATIONS_PAUSED_REASON });
    expect(creates).toEqual([]);
    await setAccountAutomationsPaused({ accountId: paused.account_id, paused: false, userId: PERSON });
  });

  test('an App event is skipped with the reason', async () => {
    await setAccountAutomationsPaused({ accountId: paused.account_id, paused: true, userId: PERSON });
    const [event] = await db
      .insert(projectMonitorEvents)
      .values({ projectId: paused.project_id, slug: 'bank-reply', boxEpoch: 'app:00000000-0000-4000-a000-000000000001', seq: 1, kind: 'event', line: { text: 'boom' }, emittedAt: new Date() })
      .returning();

    expect(await processMonitorEvent(event!, new Date())).toBe('skipped');

    const [after] = await db
      .select({ status: projectMonitorEvents.status, lastError: projectMonitorEvents.lastError })
      .from(projectMonitorEvents)
      .where(eq(projectMonitorEvents.eventId, event!.eventId));
    expect(after).toEqual({ status: 'skipped', lastError: ACCOUNT_AUTOMATIONS_PAUSED_REASON });
    await setAccountAutomationsPaused({ accountId: paused.account_id, paused: false, userId: PERSON });
  });
});
