// Real-DB characterization of reconcileRuntimeWakeFences: the candidate
// selection predicate, the cleanup claim, and the guarded cleanup-result write.
// The provider is faked; every SQL statement runs against real PostgreSQL.
//
// Runs in the `db-suites` lane of `pnpm test` (one throwaway database per file).
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { accounts, createDb, projects, projectSessions, sessionSandboxes, type Database } from '@kortix/db';

const providerStatus = new Map<string, string>();
const stopped: string[] = [];
const realProviders = await import('../platform/providers');
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    getStatus: async (externalId: string) => providerStatus.get(externalId) ?? 'unknown',
    stop: async (externalId: string) => { stopped.push(externalId); },
  }),
}));
const { reconcileRuntimeWakeFences } = await import('../services/sessions/lifecycle/runtime-wake-maintenance');

const ACCOUNT_ID = '00000000-0000-4000-a000-000000009401';
const PROJECT_ID = '00000000-0000-4000-a000-000000009402';
const CASES = {
  expiredWake: '00000000-0000-4000-a000-000000009411',
  lateStartGuard: '00000000-0000-4000-a000-000000009412',
  liveWake: '00000000-0000-4000-a000-000000009413',
  heldCleanup: '00000000-0000-4000-a000-000000009414',
} as const;

let testDb: Database | null = null;
function db(): Database {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  if (!testDb) testDb = createDb(process.env.TEST_DATABASE_URL, { max: 1 });
  return testDb;
}

const now = new Date();
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

async function metadataOf(sandboxId: string): Promise<Record<string, unknown>> {
  const [row] = await db().select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId));
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  const d = db();
  await d.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Wake maintenance E2E' });
  await d.insert(projects).values({
    projectId: PROJECT_ID, accountId: ACCOUNT_ID, name: 'Wake maintenance E2E', repoUrl: 'https://example.test/r.git',
  });
  const metadata: Record<keyof typeof CASES, Record<string, unknown>> = {
    // Wake claim whose lease expired: selected, claimed as failed, VM stopped.
    expiredWake: { runtimeWakeId: 'wake-1', runtimeWakeLeaseExpiresAt: at(-60_000) },
    // Late-start guard still open, no wake claim: selected, status recorded.
    lateStartGuard: { runtimeWakeCleanupUntilAt: at(10 * 60_000) },
    // Wake claim still leased: never selected.
    liveWake: { runtimeWakeId: 'wake-2', runtimeWakeLeaseExpiresAt: at(10 * 60_000) },
    // Guard open but another worker holds the cleanup lease: never selected.
    heldCleanup: {
      runtimeWakeCleanupUntilAt: at(10 * 60_000),
      runtimeWakeCleanupId: 'other-worker',
      runtimeWakeCleanupLeaseExpiresAt: at(10 * 60_000),
    },
  };
  for (const [name, sandboxId] of Object.entries(CASES) as Array<[keyof typeof CASES, string]>) {
    await d.insert(projectSessions).values({
      sessionId: `wake-${name}`, accountId: ACCOUNT_ID, projectId: PROJECT_ID, branchName: `b/wake-${name}`, status: 'stopped',
    });
    await d.insert(sessionSandboxes).values({
      sandboxId, sessionId: `wake-${name}`, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
      status: 'stopped', provider: 'daytona', externalId: `ext-${name}`, metadata: metadata[name],
    });
  }
  providerStatus.set('ext-expiredWake', 'running');
  providerStatus.set('ext-lateStartGuard', 'stopped');
  providerStatus.set('ext-liveWake', 'running');
  providerStatus.set('ext-heldCleanup', 'running');
});

afterAll(async () => {
  const d = db();
  const sessionIds = Object.keys(CASES).map((name) => `wake-${name}`);
  await d.update(projectSessions)
    .set({ metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb` })
    .where(inArray(projectSessions.sessionId, sessionIds));
  await d.delete(sessionSandboxes).where(inArray(sessionSandboxes.sandboxId, Object.values(CASES)));
  await d.delete(projectSessions).where(inArray(projectSessions.sessionId, sessionIds));
  await d.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await d.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
});

describe('reconcileRuntimeWakeFences (real PostgreSQL)', () => {
  test('selects only open leases, stops a late VM, records a checked status, and releases the cleanup lease', async () => {
    const result = await reconcileRuntimeWakeFences(now);
    expect(result).toEqual({ checked: 2, stopped: 1, removed: 0, errors: 0 });
    expect(stopped).toEqual(['ext-expiredWake']);

    const expired = await metadataOf(CASES.expiredWake);
    expect(expired.runtimeWakeError).toBe('wake_lease_expired');
    expect(typeof expired.runtimeWakeLateStartStoppedAt).toBe('string');
    expect(typeof expired.runtimeWakeCleanupUntilAt).toBe('string');
    expect(expired.runtimeWakeCleanupId).toBeUndefined();
    expect(expired.runtimeWakeCleanupLeaseExpiresAt).toBeUndefined();

    const guarded = await metadataOf(CASES.lateStartGuard);
    expect(guarded.runtimeWakeLateStartProviderStatus).toBe('stopped');
    expect(typeof guarded.runtimeWakeLateStartCheckedAt).toBe('string');
    expect(guarded.runtimeWakeCleanupId).toBeUndefined();
    expect(guarded.runtimeWakeCleanupLeaseExpiresAt).toBeUndefined();

    expect((await metadataOf(CASES.liveWake)).runtimeWakeLateStartCheckedAt).toBeUndefined();
    const held = await metadataOf(CASES.heldCleanup);
    expect(held.runtimeWakeCleanupId).toBe('other-worker');
    expect(held.runtimeWakeLateStartCheckedAt).toBeUndefined();
  });
});
