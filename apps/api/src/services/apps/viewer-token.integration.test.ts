import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, apps, createDb, oauthAccessTokens, oauthClients, projects, type Database } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { validateOAuthAccessToken } from '../oauth/access-token';
import { mintAppViewerToken, resetAppViewerCaches, revokeAppViewerTokens } from './viewer';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c201';
const PROJECT_ID = '00000000-0000-4000-a000-00000000c202';
const APP_ID = '00000000-0000-4000-a000-00000000c203';
const VIEWER_ID = '00000000-0000-4000-a000-00000000c204';
const APP = { appId: APP_ID, accountId: ACCOUNT_ID, name: 'Viewer token test', viewerTokenScope: 'api' };

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 2 });
  return integrationDb;
}

async function cleanup(): Promise<void> {
  const database = testDb();
  await database.delete(oauthClients).where(eq(oauthClients.appId, APP_ID));
  await database.delete(apps).where(eq(apps.appId, APP_ID));
  await database.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await database.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

/** What another API replica, `/v1/oauth/revoke`, or a consent revoke does: the row dies, this process's cache does not hear of it. */
async function revokeElsewhere(): Promise<void> {
  const [client] = await testDb().select({ clientId: oauthClients.clientId }).from(oauthClients)
    .where(eq(oauthClients.appId, APP_ID)).limit(1);
  await testDb().update(oauthAccessTokens).set({ revokedAt: new Date() })
    .where(eq(oauthAccessTokens.clientId, client!.clientId));
}

describeWithDb('App viewer token cache — real PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    const database = testDb();
    await database.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'Viewer token test' });
    await database.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'Viewer token test',
      repoUrl: 'https://example.test/viewer-token.git',
      metadata: { experimental: { apps: true } },
    });
    await database.insert(apps).values({
      appId: APP_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: 'viewer-token-test',
      name: 'Viewer token test',
      routeKey: 'cccccccccccccccc',
      createdBy: VIEWER_ID,
      viewerTokenScope: 'api',
    });
  });
  afterAll(cleanup);

  test('a live cached token is reused: one row per viewer per hour, not one per request', async () => {
    resetAppViewerCaches();
    const first = await mintAppViewerToken(APP, VIEWER_ID);
    const second = await mintAppViewerToken(APP, VIEWER_ID);
    expect(second!.accessToken).toBe(first!.accessToken);
    expect((await validateOAuthAccessToken(first!.accessToken)).isValid).toBe(true);
  });

  test('a token revoked outside this process is never handed out again', async () => {
    resetAppViewerCaches();
    const cached = await mintAppViewerToken(APP, VIEWER_ID);
    await revokeElsewhere();
    expect((await validateOAuthAccessToken(cached!.accessToken)).isValid).toBe(false);

    const next = await mintAppViewerToken(APP, VIEWER_ID);
    expect(next!.accessToken).not.toBe(cached!.accessToken);
    const verdict = await validateOAuthAccessToken(next!.accessToken);
    expect(verdict).toMatchObject({ isValid: true, userId: VIEWER_ID, accountId: ACCOUNT_ID });
    expect(verdict.scopes).toEqual(['profile', 'email', 'kortix']);
  });

  test('an access-policy save revokes every live token, and the next request gets a working one', async () => {
    resetAppViewerCaches();
    const before = await mintAppViewerToken(APP, VIEWER_ID);
    expect(await revokeAppViewerTokens(APP_ID)).toBeGreaterThan(0);
    const after = await mintAppViewerToken(APP, VIEWER_ID);
    expect(after!.accessToken).not.toBe(before!.accessToken);
    expect((await validateOAuthAccessToken(after!.accessToken)).isValid).toBe(true);
  });
});
