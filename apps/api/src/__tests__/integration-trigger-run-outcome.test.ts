/**
 * Integration test (real PostgreSQL): a trigger run's outcome reaches its trigger.
 *
 * Prod 2026-09-30: a reused trigger session failed every run for hours while
 * the trigger read `fired`, and nobody was told. Proves the SQL guards of
 * recordTriggerRunEnd: one push on the healthy → failed transition, recovery
 * on the next good run, no write for anything that is not a trigger run, and a
 * session too large to compact is never reused again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectSessions, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../lib/db';
import {
  findKeyedTriggerSession,
  findReusableTriggerSession,
  markGitTriggerAttemptFailed,
  markGitTriggerFired,
} from '../projects/lib/trigger-fire';
import { recordTriggerRunEnd, type TriggerRunEnd } from '../projects/lib/trigger-run-outcome';
import { markTriggerRuntimeDelivered } from '../projects/trigger-execution-store';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SLUG = 'triage';

type Push = { type: string; sessionId: string; projectId: string; recipients?: string[] };
let pushes: Push[] = [];
const notify = (async (event: Push) => {
  pushes.push(event);
}) as unknown as Parameters<typeof recordTriggerRunEnd>[1];

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

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'trigger-run-outcome-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'trigger runs', repoUrl: 'https://example.test/runs.git' });
  await insertIntoView(db, accountMembers, { accountId: ACCOUNT, userId: OWNER, accountRole: 'owner' });
});

beforeEach(async () => {
  pushes = [];
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db
    .insert(projectTriggerRuntime)
    .values({ projectId: PROJECT, slug: SLUG, lastStatus: 'fired', lastError: null, runFailingSince: null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: { lastStatus: 'fired', lastError: null, runFailingSince: null, updatedAt: new Date() },
    });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a trigger run that fails', () => {
  test('marks the trigger failed with the reason and pushes the account owner once', async () => {
    const sessionId = await seedSession();
    expect(await recordTriggerRunEnd(end(sessionId), notify)).toBe('failed');
    const row = await trigger();
    expect(row.lastStatus).toBe('failed');
    expect(row.lastError).toBe('Out of credits: Payment Required: Insufficient credits. Balance: $-0.06');
    expect(pushes).toEqual([{ type: 'error', sessionId, projectId: PROJECT, recipients: [OWNER] }]);

    // The next failed run refreshes the reason without a second push.
    expect(
      await recordTriggerRunEnd(end(sessionId, { error: { name: 'UnknownError', message: 'socket hang up' } }), notify),
    ).toBe('still_failed');
    expect((await trigger()).lastError).toBe('Provider unavailable: socket hang up');
    expect(pushes).toHaveLength(1);
  });

  test('two runs that fail at once push the owner once', async () => {
    const [a, b] = await Promise.all([seedSession(), seedSession()]);
    const results = await Promise.all([recordTriggerRunEnd(end(a), notify), recordTriggerRunEnd(end(b), notify)]);
    expect(results.sort()).toEqual(['failed', 'still_failed']);
    expect(pushes).toHaveLength(1);
  });

  test('the next good run clears the failure', async () => {
    const sessionId = await seedSession();
    await recordTriggerRunEnd(end(sessionId), notify);
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }), notify)).toBe('recovered');
    const row = await trigger();
    expect(row.lastStatus).toBe('fired');
    expect(row.lastError).toBeNull();
    // A good run on a healthy trigger writes nothing.
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }), notify)).toBe('unchanged');
  });
});

// Dev 2026-10-01: the next fire wrote `fired` over a failed run, so the
// failure vanished and every later failed run pushed the owner again.
describe('a trigger that keeps firing after a failed run', () => {
  test('a re-fire and its delivery keep the failure, and the next failed run does not push again', async () => {
    const sessionId = await seedSession();
    expect(await recordTriggerRunEnd(end(sessionId), notify)).toBe('failed');
    const reason = (await trigger()).lastError;

    await markGitTriggerFired(PROJECT, SLUG, new Date(), 'queued');
    expect(await trigger()).toMatchObject({ lastStatus: 'failed', lastError: reason });
    await markTriggerRuntimeDelivered({ projectId: PROJECT, slug: SLUG, when: new Date() });
    expect(await trigger()).toMatchObject({ lastStatus: 'failed', lastError: reason });
    await markGitTriggerFired(PROJECT, SLUG, new Date());
    expect(await trigger()).toMatchObject({ lastStatus: 'failed', lastError: reason });

    expect(await recordTriggerRunEnd(end(sessionId), notify)).toBe('still_failed');
    expect(pushes).toHaveLength(1);

    // Only a run that finishes ends the failure; fires are then `fired` again.
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }), notify)).toBe('recovered');
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

  test('a run that fails after a failed fire pushes the owner', async () => {
    const sessionId = await seedSession();
    await markGitTriggerAttemptFailed(PROJECT, SLUG, new Date(), 'Session create failed');
    expect(await recordTriggerRunEnd(end(sessionId), notify)).toBe('failed');
    expect(pushes).toHaveLength(1);
  });

  test('a good run does not clear a failed fire', async () => {
    const sessionId = await seedSession();
    await markGitTriggerAttemptFailed(PROJECT, SLUG, new Date(), 'Session create failed');
    expect(await recordTriggerRunEnd(end(sessionId, { status: 'idle', error: null }), notify)).toBe('unchanged');
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
    expect(await recordTriggerRunEnd(end(sessionId, overrides), notify)).toBe('not_a_trigger_run');
    expect((await trigger()).lastStatus).toBe('fired');
    expect(pushes).toHaveLength(0);
  });
});

describe('a session too large to compact', () => {
  const overflow = { name: 'ContextOverflowError', message: 'Conversation history too large to compact - exceeds model context limit' };

  test('is never reused: the next reuse fire starts a fresh session', async () => {
    const older = await seedSession(triggerMetadata, new Date(Date.now() - 60_000));
    const wedged = await seedSession();
    expect(await findReusableTriggerSession(PROJECT, SLUG)).toEqual({ sessionId: wedged });

    expect(await recordTriggerRunEnd(end(wedged, { error: overflow }), notify)).toBe('failed');
    expect((await trigger()).lastError).toBe(`Conversation too long: ${overflow.message}`);
    // The retired session is skipped; the lookup falls back to the older one.
    expect(await findReusableTriggerSession(PROJECT, SLUG)).toEqual({ sessionId: older });
  });

  test('is never reused by a keyed trigger either', async () => {
    const keyed = { ...triggerMetadata, trigger_session_key: 'chat-1' };
    const sessionId = await seedSession(keyed);
    expect(await findKeyedTriggerSession(PROJECT, SLUG, 'chat-1')).toEqual({ sessionId });
    await recordTriggerRunEnd(end(sessionId, { metadata: keyed, error: overflow }), notify);
    expect(await findKeyedTriggerSession(PROJECT, SLUG, 'chat-1')).toBeNull();
  });

  test('any other failure keeps the session for the next fire', async () => {
    const sessionId = await seedSession();
    await recordTriggerRunEnd(end(sessionId), notify);
    expect(await findReusableTriggerSession(PROJECT, SLUG)).toEqual({ sessionId });
  });
});
