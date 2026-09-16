import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects, projectSessions, sessionEnvironments, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { loadSandbox } from '../sandbox-proxy/backend';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessions = ['reader', 'denied'].map((agentName) => ({
  agentName,
  sessionId: crypto.randomUUID(),
  externalId: `preview-worker-${crypto.randomUUID()}`,
  environmentId: crypto.randomUUID(),
  environmentExternalId: `preview-env-${crypto.randomUUID()}`,
}));

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'preview-principal-fixture' });
  await db.insert(projects).values({ projectId, accountId, name: 'preview-principal-fixture', repoUrl: 'https://example.test/fixture.git' });
  for (const session of sessions) {
    await db.insert(projectSessions).values({
      sessionId: session.sessionId, accountId, projectId,
      branchName: session.sessionId, agentName: session.agentName,
    });
    await db.insert(sessionSandboxes).values({
      sandboxId: session.sessionId, sessionId: session.sessionId, accountId, projectId,
      externalId: session.externalId, status: 'active',
    });
    await db.insert(sessionEnvironments).values({
      sessionId: session.sessionId, environmentId: session.environmentId, accountId, projectId,
      externalId: session.environmentExternalId, status: 'active',
    });
  }
});

afterAll(async () => {
  await db.update(projectSessions).set({ metadata: { deletedAt: new Date().toISOString() } })
    .where(eq(projectSessions.projectId, projectId));
  await db.delete(sessionEnvironments).where(eq(sessionEnvironments.projectId, projectId));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test.each(['worker', 'environment'] as const)('%s proxy resolves each session’s own agent', async (kind) => {
  for (const session of sessions) {
    const externalId = kind === 'worker' ? session.externalId : session.environmentExternalId;
    for (const input of [externalId, externalId.toUpperCase()]) {
      const record = await loadSandbox(input);
      expect(record?.sessionId).toBe(session.sessionId);
      expect(record?.projectId).toBe(projectId);
      expect(record?.accountId).toBe(accountId);
      expect(record?.agentName).toBe(session.agentName);
      expect(record?.runtimeKind).toBe(kind);
    }
  }
});
