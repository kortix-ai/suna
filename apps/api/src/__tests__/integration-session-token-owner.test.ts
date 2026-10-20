import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountTokens, projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const userId = crypto.randomUUID();
let project: SeededProject;
let sessionId: string;

beforeAll(async () => {
  project = await seedProject('session-token-owner');
  sessionId = await seedSession(project, userId);
});
afterAll(async () => { await removeSeeded([project]); });

const mint = () => createAccountToken({
  accountId: project.account_id, projectId: project.project_id,
  userId, sessionId, name: 'synthetic-session-token',
});

async function activeCount() {
  return (await db.select({ id: accountTokens.tokenId }).from(accountTokens).where(and(
    eq(accountTokens.projectId, project.project_id), eq(accountTokens.status, 'active'),
  ))).length;
}

test('a live session receives a credential; deletion cannot leave a late mint active', async () => {
  const token = await mint();
  expect(token.status).toBe('active');
  await db.update(accountTokens).set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(accountTokens.tokenId, token.tokenId));
  // Delete has already tombstoned and revoked before the in-flight mint finishes.
  await db.update(projectSessions).set({ metadata: { deletedAt: new Date().toISOString() } })
    .where(eq(projectSessions.sessionId, sessionId));
  await expect(mint()).rejects.toThrow('Session is deleted');
  expect(await activeCount()).toBe(0);
});

test('an archived project cannot receive a late session credential', async () => {
  await db.update(projectSessions).set({ metadata: {} }).where(eq(projectSessions.sessionId, sessionId));
  await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, project.project_id));
  await expect(mint()).rejects.toThrow('Project is archived');
  expect(await activeCount()).toBe(0);
});
