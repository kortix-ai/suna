/**
 * Integration test (real local DB): deleting a workspace closes every side
 * door (KRTX-1714). The delete sets `projects.status = 'archived'`, and the
 * readers below never looked at it: a public transcript link kept rendering,
 * a kgw_ key kept authorizing billed LLM calls, an App kept serving, and a
 * chat message kept starting or continuing a session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, apps, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { createGatewayKey, validateGatewayKey } from '../llm-gateway/gateway-keys';
import { createPublicShare, resolvePublicShare } from '../shared/session-public-shares';
import { loadPublicAppState } from '../apps/public-proxy-runtime';
import { continueSession, createSession } from '../projects/session-lifecycle';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const ROUTE_KEY = `ad${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`; // varchar(20)

let gatewaySecret = '';
let shareToken = '';

async function projectRow() {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, PROJECT)).limit(1);
  return row!;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'archived-doors-acct' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'archived-doors-project',
    repoUrl: 'https://example.test/archived-doors.git',
    metadata: { experimental: { apps: true } },
  });
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: 'archived-doors',
    createdBy: OWNER,
    visibility: 'project',
  });
  await db.insert(apps).values({ accountId: ACCOUNT, projectId: PROJECT, name: 'archived-doors-app', slug: ROUTE_KEY, routeKey: ROUTE_KEY });
  gatewaySecret = (await createGatewayKey({ accountId: ACCOUNT, projectId: PROJECT, name: 'ci', createdBy: OWNER })).secret_key;
  const share = await createPublicShare({ transcript: true }, { sessionId: SESSION, projectId: PROJECT, accountId: ACCOUNT, userId: OWNER });
  if (!share.ok) throw new Error('share not created');
  shareToken = share.share.public_token;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a deleted workspace closes its side doors', () => {
  test('while the workspace is live, every door is open', async () => {
    expect(await validateGatewayKey(gatewaySecret)).not.toBeNull();
    expect((await resolvePublicShare(shareToken, { requireTranscript: true })).ok).toBe(true);
    expect(await loadPublicAppState(ROUTE_KEY)).not.toBeNull();
  });

  test('after the delete: kgw_ key refused, share link gone (410), App not found', async () => {
    await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, PROJECT));
    expect(await validateGatewayKey(gatewaySecret)).toBeNull();
    const share = await resolvePublicShare(shareToken, { requireTranscript: true });
    expect(share.ok).toBe(false);
    expect(share.ok ? 0 : share.status).toBe(410);
    expect(await loadPublicAppState(ROUTE_KEY)).toBeNull();
  });

  test('after the delete: no new session starts, and no message reaches an existing one', async () => {
    await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, PROJECT));
    const created = await createSession({
      source: 'slack',
      project: await projectRow(),
      userId: OWNER,
      requestingPrincipalType: 'human',
      body: {},
    });
    expect(created.status).toBe('failed');
    expect(created.retryable).toBe(false);
    expect(created.error?.status).toBe(404);
    expect(created.error?.body).toMatchObject({ code: 'project_archived' });
    expect(await continueSession({ source: 'slack', projectId: PROJECT, sessionId: SESSION, text: 'hi' })).toBe(
      'no-session',
    );
  });
});
