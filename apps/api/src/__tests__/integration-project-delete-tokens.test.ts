import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountMembers, accounts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { app } from '../index';
import { db } from '../shared/db';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const userId = crypto.randomUUID();
let project: SeededProject;
let bearer: string;

beforeAll(async () => {
  project = await seedProject('delete-token-regression');
  await insertIntoView(db, accountMembers, [{ userId, accountId: project.account_id, accountRole: 'owner' }]);
  const pat = await createAccountToken({ accountId: project.account_id, userId, name: 'synthetic-caller' });
  bearer = `Bearer ${pat.secretKey}`;
});
afterAll(async () => { await db.delete(accounts).where(eq(accounts.accountId, project.account_id)); });

test('project DELETE removes existing session and project credentials from the live token list', async () => {
  const sessionId = await seedSession(project, userId);
  const session = await createAccountToken({ accountId: project.account_id, userId,
    projectId: project.project_id, sessionId, name: 'synthetic-session' });
  const scoped = await createAccountToken({ accountId: project.account_id, userId,
    projectId: project.project_id, name: 'synthetic-project-key' });
  const list = async () => {
    const response = await app.request('/v1/accounts/tokens', { headers: { Authorization: bearer } });
    expect(response.status).toBe(200);
    return await response.json() as Array<{ token_id: string }>;
  };
  expect((await list()).map(row => row.token_id)).toContain(session.tokenId);
  const deleted = await app.request(`/v1/projects/${project.project_id}`, {
    method: 'DELETE', headers: { Authorization: bearer },
  });
  expect(deleted.status).toBe(200);
  const ids = (await list()).map(row => row.token_id);
  expect(ids).not.toContain(session.tokenId);
  expect(ids).not.toContain(scoped.tokenId);
  expect(ids.length).toBe(1); // account-scoped caller remains usable
});

 test('a revocation failure rolls back archive so DELETE can be retried', async () => {
  const retryProject = await seedProject('retry-delete-token', { accountId: project.account_id });
  const token = await createAccountToken({ accountId: project.account_id, userId,
    projectId: retryProject.project_id, name: 'retry-project-token' });
  await db.execute(sql.raw(`CREATE FUNCTION kortix.refuse_test_token_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic revoke failure'; END $$`));
  await db.execute(sql.raw(`CREATE TRIGGER refuse_test_token_revoke BEFORE UPDATE ON kortix.account_tokens
    FOR EACH ROW WHEN (NEW.status = 'revoked') EXECUTE FUNCTION kortix.refuse_test_token_revoke()`));
  try {
    const failed = await app.request(`/v1/projects/${retryProject.project_id}`, {
      method: 'DELETE', headers: { Authorization: bearer },
    });
    expect(failed.status).toBe(500);
  } finally {
    await db.execute(sql.raw('DROP TRIGGER refuse_test_token_revoke ON kortix.account_tokens'));
    await db.execute(sql.raw('DROP FUNCTION kortix.refuse_test_token_revoke()'));
  }
  const retried = await app.request(`/v1/projects/${retryProject.project_id}`, {
    method: 'DELETE', headers: { Authorization: bearer },
  });
  expect(retried.status).toBe(200);
  const listed = await app.request('/v1/accounts/tokens', { headers: { Authorization: bearer } });
  const tokens = await listed.json() as Array<{ token_id: string }>;
  expect(tokens.map(row => row.token_id)).not.toContain(token.tokenId);
});
