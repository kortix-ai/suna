/**
 * Integration test (real PostgreSQL): session reminders ride the trigger tables.
 *
 * Proves the three SQL guards the feature depends on:
 *   1. manifest reconcile never prunes a reminder row (it lives only in the DB);
 *   2. the schedule claim fires a reminder on time and re-arms it one period later;
 *   3. a fire into a deleted session queues nothing and pauses the reminder.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  projectSessions,
  projectTriggerExecutions,
  projectTriggerRuntime,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { fireGitTrigger } from '../projects/lib/trigger-fire';
import {
  getSessionReminder,
  insertSessionReminder,
  listSessionReminders,
  reminderSpec,
  parseReminderDraft,
  setSessionReminderEnabled,
} from '../projects/lib/session-reminders';
import { claimDueScheduleSlots } from '../projects/trigger-execution-store';
import { reconcileProjectTriggerRuntime } from '../projects/trigger-runtime-catalog';
import type { GitTriggerSpec } from '../projects/triggers';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();

async function seedSession(metadata: Record<string, unknown> = {}): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `reminder-${sessionId.slice(0, 8)}`,
    createdBy: OWNER,
    metadata,
  });
  return sessionId;
}

async function seedReminder(sessionId: string, body: Record<string, unknown>, now: Date) {
  const draft = parseReminderDraft(body, now);
  if ('error' in draft) throw new Error(draft.error);
  const spec = reminderSpec({ id: `reminder.${crypto.randomUUID().slice(0, 12).replace('-', '')}`, sessionId, agent: 'kortix', draft, now });
  const row = await insertSessionReminder({ projectId: PROJECT, spec, createdBy: OWNER, firstFireAt: draft.firstFireAt, now });
  return { spec, row };
}

async function projectRow() {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, PROJECT));
  return row!;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-reminders-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'reminders',
    repoUrl: 'https://example.com/reminders.git',
  });
  await insertIntoView(db, accountMembers, { accountId: ACCOUNT, userId: OWNER, accountRole: 'owner' });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('session reminders on the trigger tables', () => {
  test('manifest reconcile prunes a stale manifest row but keeps every reminder', async () => {
    const now = new Date();
    const sessionId = await seedSession();
    const { spec } = await seedReminder(sessionId, { prompt: 'Did the email arrive?', every: '1h' }, now);
    const manifestSpec: GitTriggerSpec = { ...spec, slug: 'stale-manifest-trigger', reminder: null, sessionMode: 'fresh', pinnedSessionId: null };
    await db.insert(projectTriggerRuntime).values({
      projectId: PROJECT,
      slug: manifestSpec.slug,
      triggerType: 'cron',
      enabled: true,
      scheduleSpec: manifestSpec as unknown as Record<string, unknown>,
    });

    // An empty manifest: every manifest trigger is stale.
    const result = await reconcileProjectTriggerRuntime(PROJECT, []);

    expect(result.removed).toBe(1);
    const slugs = (await db.select({ slug: projectTriggerRuntime.slug }).from(projectTriggerRuntime).where(eq(projectTriggerRuntime.projectId, PROJECT))).map((r) => r.slug);
    expect(slugs).toContain(spec.slug);
    expect(slugs).not.toContain('stale-manifest-trigger');
  });

  test('the claim fires a due reminder once and re-arms it exactly one period later', async () => {
    const created = new Date(Date.now() - 2 * 3600_000);
    const sessionId = await seedSession();
    const { spec } = await seedReminder(sessionId, { prompt: 'check', every: '1h' }, created);
    // Make it due now.
    const due = new Date(Date.now() - 1000);
    await db.update(projectTriggerRuntime).set({ nextFireAt: due }).where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, spec.slug)));

    const now = new Date();
    const claimed = (await claimDueScheduleSlots({ now, limit: 250 })).filter((c) => c.execution.slug === spec.slug);

    expect(claimed).toHaveLength(1);
    expect((claimed[0]!.execution.spec as { reminder?: unknown }).reminder).toEqual({ everySeconds: 3600, createdAt: created.toISOString() });
    const row = await getSessionReminder(PROJECT, sessionId, spec.slug);
    expect(row?.nextFireAt?.getTime()).toBe(now.getTime() + 3600_000);
    expect(row?.lastScheduledFor?.toISOString()).toBe(due.toISOString());
  });

  test('a fire queues the reminder prompt into its own session as trigger:reminder', async () => {
    const now = new Date();
    const sessionId = await seedSession();
    const { spec } = await seedReminder(sessionId, { prompt: 'Did the email arrive?', every: '1h' }, now);

    const result = await fireGitTrigger({
      spec,
      project: await projectRow(),
      payload: {},
      renderedPrompt: 'ignored for reminders',
      source: 'cron',
      idempotencyKey: `test:${spec.slug}`,
    });

    expect(result).toMatchObject({ status: 'queued', sessionId, reason: 'prompt queued for delivery' });
    const [command] = await db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, sessionId));
    expect(command?.source).toBe('trigger:reminder');
    expect(JSON.stringify(command?.payload)).toContain(`[REMINDER ${spec.slug}`);
    expect(JSON.stringify(command?.payload)).toContain('Did the email arrive?');
    expect(JSON.stringify(command?.payload)).not.toContain('ignored for reminders');
  });

  test('a fire into a deleted session queues nothing and pauses the reminder', async () => {
    const now = new Date();
    const sessionId = await seedSession({ deletedAt: now.toISOString() });
    const { spec } = await seedReminder(sessionId, { prompt: 'check', every: '1h' }, now);

    const result = await fireGitTrigger({ spec, project: await projectRow(), payload: {}, renderedPrompt: '', source: 'cron' });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'reminder_session_gone' });
    const commands = await db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, sessionId));
    expect(commands).toHaveLength(0);
    // No fresh session was created as a fallback.
    const sessions = await db.select().from(projectSessions).where(eq(projectSessions.projectId, PROJECT));
    expect(sessions.every((s) => (s.metadata as Record<string, unknown> | null)?.trigger_slug !== spec.slug)).toBe(true);
    const row = await getSessionReminder(PROJECT, sessionId, spec.slug);
    expect(row?.enabled).toBe(false);
    expect(row?.nextFireAt).toBeNull();
  });

  test('pause clears the schedule; resume re-arms from now; a fired one-shot stays done', async () => {
    const now = new Date();
    const sessionId = await seedSession();
    const { row } = await seedReminder(sessionId, { prompt: 'check', every: '30m' }, now);

    const paused = await setSessionReminderEnabled(row, false, now);
    expect(paused.enabled).toBe(false);
    expect(paused.nextFireAt).toBeNull();

    const later = new Date(now.getTime() + 60_000);
    const resumed = await setSessionReminderEnabled(paused, true, later);
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextFireAt?.getTime()).toBe(later.getTime() + 1800_000);

    const { row: oneShot } = await seedReminder(sessionId, { prompt: 'once', in: '1h' }, later);
    await db.update(projectTriggerRuntime).set({ nextFireAt: null, lastScheduledFor: now }).where(eq(projectTriggerRuntime.slug, oneShot.slug));
    const [fired] = await db.select().from(projectTriggerRuntime).where(eq(projectTriggerRuntime.slug, oneShot.slug));
    const reenabled = await setSessionReminderEnabled(fired!, true, later);
    expect(reenabled.nextFireAt).toBeNull();

    const listed = await listSessionReminders(PROJECT, sessionId);
    expect(listed.map((r) => r.slug)).toEqual([row.slug, oneShot.slug]);
  });

  test('deleting the session row keeps no execution pointing at it', async () => {
    const now = new Date();
    const sessionId = await seedSession();
    const { spec } = await seedReminder(sessionId, { prompt: 'check', every: '1h' }, now);
    await db.delete(projectSessions).where(eq(projectSessions.sessionId, sessionId));
    const [row] = await db.select().from(projectTriggerRuntime).where(eq(projectTriggerRuntime.slug, spec.slug));
    // FK `on delete set null`: the reminder survives unpinned and its next fire pauses it.
    expect(row?.sessionId).toBeNull();
    const executions = await db.select().from(projectTriggerExecutions).where(eq(projectTriggerExecutions.slug, spec.slug));
    expect(executions).toHaveLength(0);
  });
});
