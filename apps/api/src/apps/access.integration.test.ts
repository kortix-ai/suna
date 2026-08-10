import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  accountGroups,
  accountMembers,
  accounts,
  appAccessGrants,
  apps,
  createDb,
  projects,
  type Database,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import {
  createAppAccessToken,
  persistAppAccessPolicy,
  serializeAppAccessPolicy,
  validateAppAccessPrincipals,
} from './access';
import { authorizeAppRequest } from './public-proxy';
import { invalidateIamCacheForUser } from '../iam/cache-invalidation';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000b101';
const WORKSPACE_ID = '00000000-0000-4000-a000-00000000b102';
const APP_ID = '00000000-0000-4000-a000-00000000b103';
const OWNER_ID = '00000000-0000-4000-a000-00000000b104';
const MEMBER_ID = '00000000-0000-4000-a000-00000000b105';
const GROUP_ID = '00000000-0000-4000-a000-00000000b106';
const FOREIGN_ACCOUNT_ID = '00000000-0000-4000-a000-00000000b107';
const FOREIGN_MEMBER_ID = '00000000-0000-4000-a000-00000000b108';
const FOREIGN_GROUP_ID = '00000000-0000-4000-a000-00000000b109';

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 4 });
  return integrationDb;
}

async function cleanup(): Promise<void> {
  const database = testDb();
  await database.delete(apps).where(eq(apps.workspaceId, WORKSPACE_ID));
  await database.delete(projects).where(eq(projects.workspaceId, WORKSPACE_ID));
  await database.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
  await database.delete(accounts).where(eq(accounts.accountId, FOREIGN_ACCOUNT_ID));
}

async function seedApp() {
  const database = testDb();
  await database.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'App access test' });
  await database.insert(projects).values({
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    name: 'App access test',
    repoUrl: 'https://example.test/app-access.git',
    metadata: { experimental: { apps: true } },
  });
  const [app] = await database.insert(apps).values({
    appId: APP_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    slug: 'access-test',
    name: 'Access test',
    routeKey: 'bbbbbbbbbbbbbbbb',
    createdBy: OWNER_ID,
  }).returning();
  if (!app) throw new Error('failed to seed App');
  return app;
}

describeWithDb('App access persistence — real PostgreSQL', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test('new Apps serialize as private without exposing a password value', async () => {
    const app = await seedApp();

    expect(await serializeAppAccessPolicy(app)).toEqual({
      mode: 'private',
      revision: 1,
      member_ids: [],
      group_ids: [],
      password_configured: false,
    });
  });

  test('password access stores Argon2id, increments revision, and revokes old cookies', async () => {
    const app = await seedApp();
    const oldCookie = createAppAccessToken({
      appId: APP_ID,
      kind: 'kortix',
      userId: OWNER_ID,
      revision: app.accessRevision,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const password = 'correct-horse-battery-staple';

    const updated = await persistAppAccessPolicy(app, { mode: 'password', password });

    expect(updated.accessRevision).toBe(2);
    expect(updated.accessPasswordHash).toStartWith('$argon2id$');
    expect(updated.accessPasswordHash).not.toContain(password);
    expect(await Bun.password.verify(password, updated.accessPasswordHash!)).toBe(true);
    expect(await serializeAppAccessPolicy(updated)).toEqual({
      mode: 'password',
      revision: 2,
      member_ids: [],
      group_ids: [],
      password_configured: true,
    });

    const request = new Request('https://dev-access-test-bbbbbbbbbbbbbbbb.apps.kortix.com/asset.js', {
      headers: { cookie: `__Host-kortix_app_access=${oldCookie}` },
    });
    const denied = await authorizeAppRequest(request, new URL(request.url), updated);
    expect(denied?.status).toBe(401);
    expect(await denied?.json()).toEqual({
      error: 'App authentication required',
      code: 'app_auth_required',
      access_mode: 'password',
    });
  });

  test('restricted access replaces and deduplicates member and group grants', async () => {
    const app = await seedApp();

    const updated = await persistAppAccessPolicy(app, {
      mode: 'restricted',
      memberIds: [MEMBER_ID, MEMBER_ID],
      groupIds: [GROUP_ID, GROUP_ID],
    });

    expect(updated.accessRevision).toBe(2);
    expect(updated.accessPasswordHash).toBeNull();
    expect(await serializeAppAccessPolicy(updated)).toEqual({
      mode: 'restricted',
      revision: 2,
      member_ids: [MEMBER_ID],
      group_ids: [GROUP_ID],
      password_configured: false,
    });
    const rows = await testDb().select().from(appAccessGrants)
      .where(eq(appAccessGrants.appId, APP_ID));
    expect(rows).toHaveLength(2);

    const project = await persistAppAccessPolicy(updated, { mode: 'project' });
    expect(project.accessRevision).toBe(3);
    expect(await testDb().select().from(appAccessGrants)
      .where(eq(appAccessGrants.appId, APP_ID))).toHaveLength(0);
  });

  test('restricted principals must belong to the App account', async () => {
    await seedApp();
    const database = testDb();
    await database.insert(accountMembers).values({
      accountId: ACCOUNT_ID,
      userId: MEMBER_ID,
      accountRole: 'member',
    });
    await database.insert(accountGroups).values({
      accountId: ACCOUNT_ID,
      groupId: GROUP_ID,
      name: 'App collaborators',
    });
    await database.insert(accounts).values({
      accountId: FOREIGN_ACCOUNT_ID,
      name: 'Foreign App access test',
    });
    await database.insert(accountMembers).values({
      accountId: FOREIGN_ACCOUNT_ID,
      userId: FOREIGN_MEMBER_ID,
      accountRole: 'member',
    });
    await database.insert(accountGroups).values({
      accountId: FOREIGN_ACCOUNT_ID,
      groupId: FOREIGN_GROUP_ID,
      name: 'Foreign collaborators',
    });

    expect(await validateAppAccessPrincipals(ACCOUNT_ID, {
      memberIds: [MEMBER_ID],
      groupIds: [GROUP_ID],
    })).toEqual({ ok: true });
    expect(await validateAppAccessPrincipals(ACCOUNT_ID, {
      memberIds: [FOREIGN_MEMBER_ID],
      groupIds: [],
    })).toEqual({
      ok: false,
      principalType: 'member',
      principalId: FOREIGN_MEMBER_ID,
    });
    expect(await validateAppAccessPrincipals(ACCOUNT_ID, {
      memberIds: [],
      groupIds: [FOREIGN_GROUP_ID],
    })).toEqual({
      ok: false,
      principalType: 'group',
      principalId: FOREIGN_GROUP_ID,
    });
  });

  test('Kortix App cookies stop working after account access is revoked', async () => {
    const app = await seedApp();
    await testDb().insert(accountMembers).values({
      accountId: ACCOUNT_ID,
      userId: OWNER_ID,
      accountRole: 'owner',
    });
    const token = createAppAccessToken({
      appId: APP_ID,
      kind: 'kortix',
      userId: OWNER_ID,
      revision: app.accessRevision,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const request = new Request(
      'https://dev-access-test-bbbbbbbbbbbbbbbb.apps.kortix.com/assets/app.js',
      { headers: { cookie: `__Host-kortix_app_access=${token}` } },
    );

    expect(await authorizeAppRequest(request, new URL(request.url), app)).toBeNull();

    await testDb().delete(accountMembers).where(eq(accountMembers.userId, OWNER_ID));
    invalidateIamCacheForUser(OWNER_ID);

    const denied = await authorizeAppRequest(request, new URL(request.url), app);
    expect(denied?.status).toBe(401);
    expect(await denied?.json()).toEqual({
      error: 'App authentication required',
      code: 'app_auth_required',
      access_mode: 'private',
    });
  });
});
