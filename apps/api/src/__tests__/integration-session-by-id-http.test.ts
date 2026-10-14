/**
 * `GET /v1/sessions/:sessionId` answers exactly what
 * `GET /v1/projects/:projectId/sessions/:sessionId` answers (KRTX-2316).
 *
 * A client that holds only a session id (the SDK's `restartSandbox(id)`) used
 * to list every project's first sessions page to find it, and a session older
 * than that page was "not found". The account-scoped route reads it by id. It
 * must not become a second, looser door: for each caller and each session the
 * status and the body equal the project route's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projectSessions, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { upsertResourceGrant } from '../iam/resource-grants';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
const AGENT = 'kortix';

/** Private to OWNER. */
const PRIVATE = crypto.randomUUID();
/** Visible to the whole project. */
const SHARED = crypto.randomUUID();
/** OWNER's, soft-deleted. */
const DELETED = crypto.randomUUID();

const minted: string[] = [];
const keys: Record<'owner' | 'member' | 'outsider' | 'projectScoped', string> = {
  owner: '',
  member: '',
  outsider: '',
  projectScoped: '',
};

async function mint(accountId: string, userId: string, projectId?: string): Promise<string> {
  const token = await createAccountToken({ accountId, userId, name: 'session-by-id-test', ...(projectId ? { projectId } : {}) });
  minted.push(token.tokenId);
  return token.secretKey;
}

function session(sessionId: string, visibility: 'private' | 'project', metadata: Record<string, unknown> = {}) {
  return {
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    baseRef: 'main',
    agentName: AGENT,
    status: 'stopped' as const,
    createdBy: OWNER,
    visibility,
    metadata,
  };
}

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'session-by-id-test' },
    { accountId: OTHER_ACCOUNT, name: 'session-by-id-test-other' },
  ]);
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'session-by-id-test-project',
    repoUrl: 'https://example.com/session-by-id-test.git',
  });
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: OUTSIDER, accountId: OTHER_ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
  ]);
  for (const principalId of [OWNER, MEMBER]) {
    await upsertResourceGrant({
      accountId: ACCOUNT,
      projectId: PROJECT,
      resourceType: 'agent',
      resourceId: AGENT,
      principalType: 'member',
      principalId,
      grantedBy: OWNER,
    });
  }
  await db.insert(projectSessions).values([
    session(PRIVATE, 'private'),
    session(SHARED, 'project'),
    session(DELETED, 'project', { deletedAt: new Date().toISOString() }),
  ]);

  keys.owner = await mint(ACCOUNT, OWNER);
  keys.member = await mint(ACCOUNT, MEMBER);
  keys.outsider = await mint(OTHER_ACCOUNT, OUTSIDER);
  keys.projectScoped = await mint(ACCOUNT, OWNER, PROJECT);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, OTHER_ACCOUNT));
});

async function get(path: string, key: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const byId = (sessionId: string, key: string) => get(`/v1/sessions/${sessionId}`, key);
const inProject = (sessionId: string, key: string) => get(`/v1/projects/${PROJECT}/sessions/${sessionId}`, key);

describe('GET /v1/sessions/:sessionId', () => {
  test('the owner reads a private session by id: the project route`s body, with its project_id', async () => {
    const lookup = await byId(PRIVATE, keys.owner);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ session_id: PRIVATE, project_id: PROJECT });
    expect(lookup).toEqual(await inProject(PRIVATE, keys.owner));
  });

  test('a project member reads a project-visible session', async () => {
    const lookup = await byId(SHARED, keys.member);
    expect(lookup.status).toBe(200);
    expect(lookup).toEqual(await inProject(SHARED, keys.member));
  });

  test('another member never receives the owner`s private session: 404, as on the project route', async () => {
    const lookup = await byId(PRIVATE, keys.member);
    expect(lookup.status).toBe(404);
    expect(lookup).toEqual(await inProject(PRIVATE, keys.member));
  });

  test('a caller from another account gets the project route`s answer, never the row', async () => {
    const lookup = await byId(SHARED, keys.outsider);
    expect([403, 404]).toContain(lookup.status);
    expect(lookup.status).toBe((await inProject(SHARED, keys.outsider)).status);
    expect(JSON.stringify(lookup.body)).not.toContain(SHARED);
  });

  test('a deleted session is 404 by id, as on the project route', async () => {
    const lookup = await byId(DELETED, keys.owner);
    expect(lookup.status).toBe(404);
    expect(lookup.status).toBe((await inProject(DELETED, keys.owner)).status);
  });

  test('an unknown id is 404 and a malformed id is 400', async () => {
    expect((await byId(crypto.randomUUID(), keys.owner)).status).toBe(404);
    expect((await byId('not-a-session', keys.owner)).status).toBe(400);
  });

  test('a project-scoped token is refused: the path names no project to check it against', async () => {
    expect((await byId(SHARED, keys.projectScoped)).status).toBe(403);
    // The same token still reads the session through its own project.
    expect((await inProject(SHARED, keys.projectScoped)).status).toBe(200);
  });

  test('no token is 401', async () => {
    const res = await app.request(`/v1/sessions/${SHARED}`);
    expect(res.status).toBe(401);
  });
});
