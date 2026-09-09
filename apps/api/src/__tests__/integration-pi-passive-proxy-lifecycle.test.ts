import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { accounts, projects, projectSessions, sessionEnvironments, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as realProviders from '../platform/providers';
import { db } from '../shared/db';

const starts: string[] = [];
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    getStatus: async () => 'running',
    ensureRunning: async (externalId: string) => { starts.push(externalId); },
  }),
}));
const { wakeSandbox, markSandboxUsed, markSandboxErrored } = await import('../sandbox-proxy/backend');
const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const pi = { sandbox_slug: 'pi-worker', pi_worker_boot: true, pi_worker_ref: 'main', pi_worker_sha: 'a'.repeat(40) };

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'pi-passive-proxy-fixture' });
  await db.insert(projects).values({ projectId, accountId, name: 'pi-passive-proxy-fixture', repoUrl: 'https://example.test/fixture.git' });
});
afterAll(async () => {
  await db.update(projectSessions).set({ metadata: { deletedAt: new Date().toISOString() } }).where(eq(projectSessions.projectId, projectId));
  await db.delete(sessionEnvironments).where(eq(sessionEnvironments.projectId, projectId));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

async function fixture(metadata: Record<string, unknown>, status: 'active' | 'stopped' | 'error' = 'stopped') {
  const sessionId = crypto.randomUUID();
  const externalId = 'passive-fixture-' + crypto.randomUUID();
  await db.insert(projectSessions).values({ sessionId, accountId, projectId, branchName: sessionId, status: 'stopped', metadata });
  await db.insert(sessionSandboxes).values({ sandboxId: sessionId, sessionId, accountId, projectId,
    externalId, provider: 'daytona', status, deadlineAt: new Date(Date.now() + 60 * 60_000) });
  return { sessionId, externalId,
    box: async () => (await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId)))[0]!,
    session: async () => (await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)))[0]!,
  };
}

test.each(['active', 'stopped', 'error'] as const)('passive retries never start or change lifecycle state of a %s Pi worker', async (status) => {
  const f = await fixture(pi, status);
  await wakeSandbox(f.externalId);
  expect(starts).not.toContain(f.externalId);
  await markSandboxUsed(f.externalId);
  expect((await f.box()).status).toBe(status);
  expect((await f.session()).status).toBe('stopped');
  await markSandboxErrored(f.externalId);
  expect((await f.box()).status).toBe(status);
});

test('incomplete Pi identity still cannot enter legacy wake and state repair', async () => {
  const f = await fixture({ sandbox_slug: 'pi-worker' });
  await wakeSandbox(f.externalId);
  await markSandboxUsed(f.externalId);
  await markSandboxErrored(f.externalId);
  expect(starts).not.toContain(f.externalId);
  expect((await f.box()).status).toBe('stopped');
  expect((await f.session()).status).toBe('stopped');
});

test('OpenCode keeps its existing deadline-authorized proxy recovery', async () => {
  const f = await fixture({});
  await wakeSandbox(f.externalId);
  expect(starts.filter((id) => id === f.externalId)).toHaveLength(1);
  await markSandboxUsed(f.externalId);
  expect((await f.box()).status).toBe('active');
  expect((await f.session()).status).toBe('running');
  await markSandboxErrored(f.externalId);
  expect((await f.box()).status).toBe('error');
});

test('the Pi worker fence does not suppress the execution environment recovery path', async () => {
  const f = await fixture(pi, 'active');
  const externalId = 'passive-environment-' + crypto.randomUUID();
  await db.insert(sessionEnvironments).values({ sessionId: f.sessionId, environmentId: crypto.randomUUID(),
    projectId, accountId, externalId, provider: 'daytona', status: 'stopped' });
  await wakeSandbox(externalId);
  expect(starts.filter((id) => id === externalId)).toHaveLength(1);
  const [environment] = await db.select().from(sessionEnvironments).where(eq(sessionEnvironments.sessionId, f.sessionId));
  expect(environment?.status).toBe('active');
});
