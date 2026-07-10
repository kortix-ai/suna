import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';

// GET /:projectId/detail must stay loadable by a plain `member` even though
// member lacks project.file.read: the fix filters the file list OUT of the
// response rather than 403-ing the whole bundle (a hard assert would lock every
// member out of the workspace shell). This proves the coarse floor stayed
// project.read and the file section is blanked, not gated.
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const EDITOR = crypto.randomUUID();

const minted: string[] = [];

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'detail-cap-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'detail-cap-test-project',
    repoUrl: 'https://example.com/detail-cap-test.git',
  });
  await db.insert(accountMembers).values([
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: EDITOR, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await db.insert(projectMembers).values([
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: EDITOR, projectRole: 'editor' },
  ]);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function mint(userId: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'detail-cap-test',
    agentGrant: null as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function getDetail(secret: string) {
  return app.request(`/v1/projects/${PROJECT}/detail`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
}

describe('HTTP — GET /detail stays loadable for a member (file list filtered, not 403)', () => {
  test('plain MEMBER (no file.read) → NOT 403 (workspace shell still loads)', async () => {
    const secret = await mint(MEMBER);
    const res = await getDetail(secret);
    // The whole point: member must not be denied the bundle. The old naive fix
    // (assertProjectCapability(file.read)) would 403 here.
    expect(res.status).not.toBe(403);
  });

  test('plain MEMBER → the file list is blanked (no file paths leak via /detail)', async () => {
    const secret = await mint(MEMBER);
    const res = await getDetail(secret);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.files).toEqual([]);
      expect(body.file_count).toBe(0);
      // The config bundle is still present (member holds the config read leaves).
      expect(body.config).toBeDefined();
    }
  });

  test('EDITOR (has file.read) → NOT 403', async () => {
    const secret = await mint(EDITOR);
    const res = await getDetail(secret);
    expect(res.status).not.toBe(403);
  });
});
