/**
 * Integration test (real local DB): two people whose email handles match
 * (alex@a.test, alex@b.test) opening Files for the first time at once must get
 * two folders, each managed only by its owner, never one shared /Users/alex.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountMembers, accounts, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const { ensureProjectDrive, ensurePersonalFolder, listFolderGrants } = await import('../drives/service');
const { clearAuthorizeCaches } = await import('../iam/authorize');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ALEX_A = crypto.randomUUID();
const ALEX_B = crypto.randomUUID();
const handle = `alex${ACCOUNT.slice(0, 8)}`;

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email) values
      (${ALEX_A}::uuid, ${`${handle}@a.test`}),
      (${ALEX_B}::uuid, ${`${handle}@b.test`})
    on conflict do nothing`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'personal-folder-race' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'personal-folder-race',
    repoUrl: 'https://example.test/personal-folder-race.git',
    metadata: { experimental: { drives: true } },
  });
  for (const userId of [ALEX_A, ALEX_B]) await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole: 'member' });
  clearAuthorizeCaches();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`delete from auth.users where id in (${ALEX_A}::uuid, ${ALEX_B}::uuid)`);
});

test('concurrent first visits by two people with the same handle get distinct folders', async () => {
  const drive = await ensureProjectDrive(ACCOUNT, PROJECT);
  const [a, b] = await Promise.all([ensurePersonalFolder(drive, ALEX_A), ensurePersonalFolder(drive, ALEX_B)]);
  expect([a, b].sort()).toEqual([`/Users/${handle}`, `/Users/${handle}-2`]);

  const managers = (await listFolderGrants(drive)).filter((g) => g.path.startsWith('/Users/') && g.level === 'manage');
  for (const [userId, path] of [
    [ALEX_A, a],
    [ALEX_B, b],
  ]) {
    expect(managers.filter((g) => g.path === path).map((g) => g.principalId)).toEqual([userId]);
  }
});
