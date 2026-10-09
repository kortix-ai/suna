/**
 * Integration test (real PostgreSQL): a trigger run's outcome reaches its trigger.
 *
 * Prod 2026-09-30: a reused trigger session failed every run for hours while
 * the trigger read `fired`, and nobody was told. Proves the SQL guards of
 * recordTriggerRunEnd: one `automation_failed` alert to the trigger's watcher
 * on the healthy → failed transition, one `automation_recovered` alert on the
 * next good run, no write for anything that is not a trigger run, and a
 * session too large to compact is never reused again. The alert senders are
 * captured; the inbox rows are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, notifications, projectMembers, projectSessions, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  findKeyedTriggerSession,
  findReusableTriggerSession,
  markGitTriggerAttemptFailed,
  markGitTriggerFired,
} from '../projects/lib/trigger-fire';
import { setTriggerAlertNotifierForTest, settleTriggerAlerts } from '../projects/lib/trigger-alerts';
import { recordTriggerRunEnd as recordRunEnd, type TriggerRunEnd } from '../projects/lib/trigger-run-outcome';
import { upsertTriggerWatcher } from '../projects/lib/trigger-watchers';
import { markTriggerRuntimeDelivered } from '../projects/trigger-execution-store';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
/** The trigger's creator: a project member who follows its alerts. */
const WATCHER = crypto.randomUUID();
const SLUG = 'triage';

/** The run end, then every alert it started. */
async function recordTriggerRunEnd(end: TriggerRunEnd) {
  const result = await recordRunEnd(end);
  await settleTriggerAlerts();
  return result;
}

/** The alert rows of the trigger, oldest first. */
async function alerts() {
  const rows = await db
    .select({ userId: notifications.userId, kind: notifications.kind, body: notifications.body, createdAt: notifications.createdAt })
    .from(notifications)
    .where(and(eq(notifications.projectId, PROJECT), eq(notifications.triggerSlug, SLUG)));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(({ userId, kind, body }) => ({ userId, kind, body }));
}

const triggerMetadata = { trigger_kind: 'git', trigger_slug: SLUG, trigger_source: 'cron', trigger_type: 'cron' };

async function seedSession(metadata: Record<string, unknown> = triggerMetadata, createdAt = new Date()): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `trigger-${sessionId.slice(0, 8)}`,
    createdBy: OWNER,
    metadata,
    createdAt,
  });
  return sessionId;
}

async function trigger() {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, SLUG)));
  return row!;
}

function end(sessionId: string, overrides: Partial<TriggerRunEnd> = {}): TriggerRunEnd {
  return {
    projectId: PROJECT,
    accountId: ACCOUNT,
    sessionId,
    metadata: triggerMetadata,
    status: 'error',
    error: { name: 'APIError', message: 'Payment Required: Insufficient credits. Balance: $-0.06' },
    outcome: 'closed',
    childSession: false,
    ...overrides,
  };
}

const FAILED = { userId: WATCHER, kind: 'automation_failed', body: 'Out of credits: Payment Required: Insufficient credits. Balance: $-0.06' };

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'trigger-run-outcome-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'trigger runs', repoUrl: 'https://example.test/runs.git' });
  await insertIntoView(db, accountMembers, [
    { accountId: ACCOUNT, userId: OWNER, accountRole: 'owner' },
    { accountId: ACCOUNT, userId: WATCHER, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: WATCHER, projectRole: 'member' });
  await upsertTriggerWatcher({ accountId: ACCOUNT, projectId: PROJECT, slug: SLUG, userId: WATCHER });
  setTriggerAlertNotifierForTest({
    listDevices: async () => [],
    sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }),
    emailAvailable: () => false,
  });
});

beforeEach(async () => {
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(notifications).where(eq(notifications.projectId, PROJECT));
  const healthy = { lastStatus: 'fired', lastError: null, runFailingSince: null, alertFailingSince: null, alertSource: null, updatedAt: new Date() };
  await db
    .insert(projectTriggerRuntime)
    .values({ projectId: PROJECT, slug: SLUG, ...healthy })
    .onConflictDoUpdate({ target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug], set: healthy });
});

afterAll(async () => {
  setTriggerAlertNotifierForTest(null);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a trigger run that fails', () => {
  test('marks the trigger failed with the reason and alerts its watcher once, not the owner', async () => {
    const sessionId = await seedSession();
    expect(await recordTriggerRunEnd(end(sessionId))).toBe('failed');
    const row = await trigger();
    expect(row.lastStatus).toBe('failed');
    expect(row.lastError).toBe('Out of credits: Payment Required: Insufficient credits. Balance: $-0.06');
    expect(row.alertSource).toBe('run');
    expect(await alerts()).toEqual([FAILED]);

    // The next failed run refreshes the reason without a second alert.
    expect(
      await recordTriggerRunEnd(end(sessionId, { error: { name: 'UnknownError', message: 'socket hang up' } })),
    ).toBe('still_failed');
    expect((await trigger()).lastError).toBe('Provider unavailable: socket hang up');
    expect(await alerts()).toEqual([FAILED]);
  });

  test('two runs that fail at once alert once', async () => {
    const [a, b] = await Promise.all([seedSession(), seedSession()]);
    const results = await Promise.all([recordTriggerRunEnd(end(a)), recordTriggerRunEnd(end(b))]);
    expect(results.sort()).toEqual(['failed', 'still_failed']);
    expect(await alerts()).toHaveLength(1);
  });

  test('the next good run clears the failure and tells the watcher once', async () => {
    const sessionId = await seedSession();
    await recordTriggerRunEnd(end(sessionId));
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }))).toBe('recovered');
    const row = await trigger();
    expect(row.lastStatus).toBe('fired');
    expect(row.lastError).toBeNull();
    expect(row.alertFailingSince).toBeNull();
    // A good run on a healthy trigger writes nothing.
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }))).toBe('unchanged');
    expect(await alerts()).toEqual([FAILED, { userId: WATCHER, kind: 'automation_recovered', body: '' }]);
  });
});

// Dev 2026-10-01: the next fire wrote `fired` over a failed run, so the
// failure vanished and every later failed run pushed the owner again.
describe('a trigger that keeps firing after a failed run', () => {
  test('a re-fire and its delivery keep the failure, and the next failed run does not alert again', async () => {
    const sessionId = await seedSession();
    expect(await recordTriggerRunEnd(end(sessionId))).toBe('failed');
    const reason = (await trigger()).lastError;

    await markGitTriggerFired(PROJECT, SLUG, new Date(), 'queued');
    expect(await trigger()).toMatchObject({ lastStatus: 'failed', lastError: reason });
    await markTriggerRuntimeDelivered({ projectId: PROJECT, slug: SLUG, when: new Date() });
    expect(await trigger()).toMatchObject({ lastStatus: 'failed', lastError: reason });
    await markGitTriggerFired(PROJECT, SLUG, new Date());
    expect(await trigger()).toMatchObject({ lastStatus: 'failed', lastError: reason });

    expect(await recordTriggerRunEnd(end(sessionId))).toBe('still_failed');
    // A fire never ends a run failure's alert either.
    expect(await alerts()).toEqual([FAILED]);

    // Only a run that finishes ends the failure; fires are then `fired` again.
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }))).toBe('recovered');
    await markGitTriggerFired(PROJECT, SLUG, new Date(), 'queued');
    expect(await trigger()).toMatchObject({ lastStatus: 'queued', lastError: null, runFailingSince: null });
  });

  test('a failed fire still clears on the next fire', async () => {
    // A pinned trigger's session carries no trigger metadata, so no run
    // outcome ever reaches its trigger: only a fire can clear a fire failure.
    await markGitTriggerAttemptFailed(PROJECT, SLUG, new Date(), 'Session create failed');
    expect((await trigger()).lastStatus).toBe('failed');
    await markGitTriggerFired(PROJECT, SLUG, new Date());
    expect(await trigger()).toMatchObject({ lastStatus: 'fired', lastError: null });
  });

  test('a run that fails after a failed fire alerts the watcher', async () => {
    const sessionId = await seedSession();
    await markGitTriggerAttemptFailed(PROJECT, SLUG, new Date(), 'Session create failed');
    expect(await recordTriggerRunEnd(end(sessionId))).toBe('failed');
    expect(await alerts()).toEqual([FAILED]);
  });

  test('a good run does not clear a failed fire', async () => {
    const sessionId = await seedSession();
    await markGitTriggerAttemptFailed(PROJECT, SLUG, new Date(), 'Session create failed');
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }))).toBe('unchanged');
    expect(await trigger()).toMatchObject({ lastStatus: 'failed', lastError: 'Session create failed' });
  });
});

describe('ends that are not a trigger run outcome', () => {
  test.each([
    ['a session no trigger created', { metadata: {} }],
    ['a stop the user asked for', { error: { name: 'MessageAbortedError', message: 'Aborted' } }],
    ['a subagent session', { childSession: true }],
    ['an end that closed no turn (a replay)', { outcome: 'already_closed' as const }],
  ])('%s leaves the trigger untouched', async (_name, overrides) => {
    const sessionId = await seedSession();
    expect(await recordTriggerRunEnd(end(sessionId, overrides))).toBe('not_a_trigger_run');
    expect((await trigger()).lastStatus).toBe('fired');
    expect(await alerts()).toEqual([]);
  });
});

describe('a session too large to compact', () => {
  const overflow = { name: 'ContextOverflowError', message: 'Conversation history too large to compact - exceeds model context limit' };

  test('is never reused: the next reuse fire starts a fresh session', async () => {
    const older = await seedSession(triggerMetadata, new Date(Date.now() - 60_000));
    const wedged = await seedSession();
    expect(await findReusableTriggerSession(PROJECT, SLUG)).toEqual({ sessionId: wedged });

    expect(await recordTriggerRunEnd(end(wedged, { error: overflow }))).toBe('failed');
    expect((await trigger()).lastError).toBe(`Conversation too long: ${overflow.message}`);
    // The retired session is skipped; the lookup falls back to the older one.
    expect(await findReusableTriggerSession(PROJECT, SLUG)).toEqual({ sessionId: older });
  });

  test('is never reused by a keyed trigger either', async () => {
    const keyed = { ...triggerMetadata, trigger_session_key: 'chat-1' };
    const sessionId = await seedSession(keyed);
    expect(await findKeyedTriggerSession(PROJECT, SLUG, 'chat-1')).toEqual({ sessionId });
    await recordTriggerRunEnd(end(sessionId, { metadata: keyed, error: overflow }));
    expect(await findKeyedTriggerSession(PROJECT, SLUG, 'chat-1')).toBeNull();
  });

  test('any other failure keeps the session for the next fire', async () => {
    const sessionId = await seedSession();
    await recordTriggerRunEnd(end(sessionId));
    expect(await findReusableTriggerSession(PROJECT, SLUG)).toEqual({ sessionId });
  });
});
