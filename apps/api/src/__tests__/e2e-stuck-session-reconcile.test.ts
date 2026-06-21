// Real-DB e2e for the session-side reaper reconciliation (reconcileStuckActiveSessions).
//
// The provider reaper (reapAndReconcileSandboxes) needs a live Daytona to test;
// THIS pass is DB-only, so it gets a real end-to-end test against an actual
// Postgres. It exercises the exact decision matrix that keeps the concurrent-
// session cap honest: a stuck active-status session with no live box is drained
// to `stopped`, while a session that is genuinely live (active box / recent LLM
// usage / an in-flight turn) or still within the TTL is left untouched.
//
// Gated on TEST_DATABASE_URL + explicit confirmation + non-prod (it writes and
// deletes rows). Skips otherwise — same harness contract as the other e2e suites.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  accounts,
  projects,
  projectSessions,
  sessionSandboxes,
  usageEvents,
  chatTurnStreams,
  type Database,
} from '@kortix/db';
import { reconcileStuckActiveSessions } from '../projects/sandbox-reaper';

const TEST_DB_CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === TEST_DB_CONFIRMATION &&
  process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009301';
const PROJECT_ID = '00000000-0000-4000-a000-000000009302';
const SANDBOX_STOPPED = '00000000-0000-4000-a000-000000009303';
const SANDBOX_ACTIVE = '00000000-0000-4000-a000-000000009304';

// Sessions covering the full decision matrix. *_STUCK should be reconciled to
// 'stopped'; *_KEEP should be left exactly as seeded.
const S_NO_BOX_STUCK = 'stuck-no-box';
const S_STOPPED_BOX_STUCK = 'stuck-stopped-box';
const S_ACTIVE_BOX_KEEP = 'keep-active-box';
const S_RECENT_USAGE_KEEP = 'keep-recent-usage';
const S_INFLIGHT_TURN_KEEP = 'keep-inflight-turn';
const S_WITHIN_TTL_KEEP = 'keep-within-ttl';
const ALL_SESSIONS = [
  S_NO_BOX_STUCK, S_STOPPED_BOX_STUCK, S_ACTIVE_BOX_KEEP,
  S_RECENT_USAGE_KEEP, S_INFLIGHT_TURN_KEEP, S_WITHIN_TTL_KEEP,
];

let testDb: Database | null = null;
function db(): Database {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  if (!testDb) testDb = createDb(process.env.TEST_DATABASE_URL, { max: 1 });
  return testDb;
}

const minsAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

async function cleanup() {
  const d = db();
  await d.delete(usageEvents).where(inArray(usageEvents.sessionId, ALL_SESSIONS));
  await d.delete(chatTurnStreams).where(inArray(chatTurnStreams.sessionId, ALL_SESSIONS));
  await d.delete(sessionSandboxes).where(inArray(sessionSandboxes.sandboxId, [SANDBOX_STOPPED, SANDBOX_ACTIVE]));
  await d.delete(projectSessions).where(inArray(projectSessions.sessionId, ALL_SESSIONS));
  await d.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await d.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed(now: Date) {
  const d = db();
  const old = minsAgo(now, 30); // older than the 15m auto-stop TTL → a candidate
  await d.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Reaper E2E Acct' });
  await d.insert(projects).values({
    projectId: PROJECT_ID, accountId: ACCOUNT_ID, name: 'Reaper E2E', repoUrl: 'https://example.test/r.git',
  });

  // One session row per case (distinct branch_name — unique per project).
  const sess = (sessionId: string, status: 'running' | 'provisioning', updatedAt: Date) => ({
    sessionId, accountId: ACCOUNT_ID, projectId: PROJECT_ID, branchName: `b/${sessionId}`,
    status, createdAt: minsAgo(now, 60), updatedAt,
  });
  await d.insert(projectSessions).values([
    sess(S_NO_BOX_STUCK, 'running', old),
    sess(S_STOPPED_BOX_STUCK, 'provisioning', old),
    sess(S_ACTIVE_BOX_KEEP, 'running', old),
    sess(S_RECENT_USAGE_KEEP, 'running', old),
    sess(S_INFLIGHT_TURN_KEEP, 'running', old),
    sess(S_WITHIN_TTL_KEEP, 'provisioning', now), // fresh → within TTL
  ]);

  // A stopped box behind one stuck session (must NOT keep it alive); an ACTIVE
  // box behind the keep session (the provider reaper owns that one).
  await d.insert(sessionSandboxes).values([
    { sandboxId: SANDBOX_STOPPED, sessionId: S_STOPPED_BOX_STUCK, accountId: ACCOUNT_ID, projectId: PROJECT_ID, status: 'stopped', externalId: 'ext-stopped' },
    { sandboxId: SANDBOX_ACTIVE, sessionId: S_ACTIVE_BOX_KEEP, accountId: ACCOUNT_ID, projectId: PROJECT_ID, status: 'active', externalId: 'ext-active' },
  ]);

  // Recent LLM usage → meaningful activity within the TTL window.
  await d.insert(usageEvents).values({
    accountId: ACCOUNT_ID, projectId: PROJECT_ID, sessionId: S_RECENT_USAGE_KEEP,
    provider: 'kortix', model: 'test', route: 'chat', createdAt: minsAgo(now, 2),
  });
  // An in-flight (unfinalized) turn → never reap.
  await d.insert(chatTurnStreams).values({
    sessionId: S_INFLIGHT_TURN_KEEP, projectId: PROJECT_ID, teamId: 't', channel: 'c',
    triggerTs: '1', finalized: false, originatingEvent: {}, expiresAt: minsAgo(now, -60),
  });
}

async function statusOf(sessionId: string): Promise<string> {
  const [row] = await db().select({ status: projectSessions.status }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return row?.status ?? '<missing>';
}

describeWithDb('reconcileStuckActiveSessions (real DB)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test('drains stuck active-status sessions with no live box; leaves live/fresh ones', async () => {
    const now = new Date();
    await seed(now);

    const result = await reconcileStuckActiveSessions(now);

    // Both genuinely-stuck sessions reconciled to 'stopped'.
    expect(await statusOf(S_NO_BOX_STUCK)).toBe('stopped');
    expect(await statusOf(S_STOPPED_BOX_STUCK)).toBe('stopped');

    // Everything with a live box / recent activity / in-flight turn / within TTL
    // is untouched.
    expect(await statusOf(S_ACTIVE_BOX_KEEP)).toBe('running');
    expect(await statusOf(S_RECENT_USAGE_KEEP)).toBe('running');
    expect(await statusOf(S_INFLIGHT_TURN_KEEP)).toBe('running');
    expect(await statusOf(S_WITHIN_TTL_KEEP)).toBe('provisioning');

    // Reported exactly the two it changed.
    expect(result.reconciled).toBe(2);
    expect(result.errors).toBe(0);
  });

  test('idempotent — a second pass finds nothing new', async () => {
    const now = new Date();
    await seed(now);
    await reconcileStuckActiveSessions(now);
    const second = await reconcileStuckActiveSessions(now);
    expect(second.reconciled).toBe(0);
  });
});
