/**
 * Integration test (real local DB, real routes): an agent configures its
 * space for its person. A session token changes a space through
 * `PATCH /spaces/:spaceId` and the members routes with the rights of the
 * session's person, never more:
 *
 * - a thread of the channel's creator renames and describes it, and sets its agents;
 * - a thread of a project manager renames it;
 * - a thread of a member who did not create it gets the same 403 the person gets, but may add people;
 * - a thread filed elsewhere, whose person is not in the channel, gets 403;
 * - making a channel private stays a person's step (403 `session_bound_caller`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectMembers, projectSessions, projectSpaceMembers, projectSpaces, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const SAM = crypto.randomUUID();
const ENG = crypto.randomUUID();
const PRIYA_ENG = crypto.randomUUID();
const SAM_ENG = crypto.randomUUID();
const MANAGER_ENG = crypto.randomUUID();
const SAM_GENERAL = crypto.randomUUID();
const USERS = [MANAGER, PRIYA, SAM] as const;
const minted: string[] = [];
const keys: Record<string, string> = {};

async function mint(userId: string, sessionId?: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'space-agent-config-test',
    agentGrant: null as any,
    ...(sessionId ? { sessionId } : {}),
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function call(method: string, path: string, secret: string, body?: unknown) {
  const res = await app.request(`/v1/projects/${PROJECT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const engRow = async () => (await db.select().from(projectSpaces).where(eq(projectSpaces.spaceId, ENG)))[0]!;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'space-agent-config' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'Config', repoUrl: 'https://example.test/c.git', metadata: { experimental: { chat: true } } });
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(db, accountMembers, USERS.map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })));
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: PRIYA, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: SAM, projectRole: 'member' },
  ]);
  keys.manager = await mint(MANAGER);
  const list = await app.request(`/v1/projects/${PROJECT}/spaces`, { headers: { Authorization: `Bearer ${keys.manager}` } });
  const general = ((await list.json()) as any).spaces.find((s: any) => s.is_default).space_id as string;
  await db.insert(projectSpaces).values({ spaceId: ENG, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `eng-${ENG.slice(0, 6)}`, name: 'eng', createdBy: PRIYA });
  await db.insert(projectSpaceMembers).values([
    { spaceId: ENG, userId: PRIYA, addedBy: PRIYA },
    { spaceId: ENG, userId: SAM, addedBy: PRIYA },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'kortix', visibility: 'project', metadata: {} } as const;
  await db.insert(projectSessions).values([
    { ...base, sessionId: PRIYA_ENG, branchName: PRIYA_ENG, createdBy: PRIYA, spaceId: ENG },
    { ...base, sessionId: SAM_ENG, branchName: SAM_ENG, createdBy: SAM, spaceId: ENG },
    { ...base, sessionId: MANAGER_ENG, branchName: MANAGER_ENG, createdBy: MANAGER, spaceId: ENG },
    { ...base, sessionId: SAM_GENERAL, branchName: SAM_GENERAL, createdBy: SAM, spaceId: general },
  ]);
  // A session credential is valid only while its sandbox is live.
  await db.insert(sessionSandboxes).values(
    [PRIYA_ENG, SAM_ENG, MANAGER_ENG, SAM_GENERAL].map((sessionId) => ({
      sandboxId: crypto.randomUUID(),
      sessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      externalId: `sc-${sessionId.slice(0, 8)}`,
      status: 'active' as const,
    })),
  );
  keys.priyaEng = await mint(PRIYA, PRIYA_ENG);
  keys.samEng = await mint(SAM, SAM_ENG);
  keys.managerEng = await mint(MANAGER, MANAGER_ENG);
  keys.samGeneral = await mint(SAM, SAM_GENERAL);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

describe('an agent configures its space with its person’s rights', () => {
  test('a thread of the channel’s creator renames it, describes it and sets its agents', async () => {
    const res = await call('PATCH', `/spaces/${ENG}`, keys.priyaEng, { name: `launch-${ENG.slice(0, 6)}`, description: 'Everything for the November launch', agents: [] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ space_id: ENG, slug: `launch-${ENG.slice(0, 6)}`, description: 'Everything for the November launch', agents: [] });
    expect(await engRow()).toMatchObject({ slug: `launch-${ENG.slice(0, 6)}`, description: 'Everything for the November launch' });
  });

  test('a thread of a project manager renames it: the person’s standing comes through the token', async () => {
    const res = await call('PATCH', `/spaces/${ENG}`, keys.managerEng, { name: `eng-${ENG.slice(0, 6)}` });
    expect(res.status).toBe(200);
    expect((await engRow()).slug).toBe(`eng-${ENG.slice(0, 6)}`);
  });

  test('a thread of a member who did not create it gets the person’s 403, and the channel stays as it was', async () => {
    const person = await call('PATCH', `/spaces/${ENG}`, (keys.sam ??= await mint(SAM)), { name: 'sams-name' });
    const agent = await call('PATCH', `/spaces/${ENG}`, keys.samEng, { name: 'sams-name' });
    expect([person.status, person.body.code]).toEqual([403, 'forbidden']);
    expect([agent.status, agent.body.code]).toEqual([403, 'forbidden']);
    expect((await engRow()).slug).toBe(`eng-${ENG.slice(0, 6)}`);
  });

  test('a member’s thread adds a person to the channel, as the member may', async () => {
    const res = await call('POST', `/spaces/${ENG}/members`, keys.samEng, { user_ids: [MANAGER] });
    expect(res.status).toBe(200);
    const rows = await db.select({ userId: projectSpaceMembers.userId }).from(projectSpaceMembers).where(eq(projectSpaceMembers.spaceId, ENG));
    expect(rows.map((r) => r.userId).sort()).toEqual([MANAGER, PRIYA, SAM].sort());
    // The creator's thread removes them again.
    expect((await call('DELETE', `/spaces/${ENG}/members/${MANAGER}`, keys.priyaEng)).status).toBe(200);
  });

  test('a thread filed elsewhere, whose person is in the channel, may; making a channel private stays a person’s step', async () => {
    const elsewhere = await call('PATCH', `/spaces/${ENG}`, keys.samGeneral, { description: 'from general' });
    // Sam is a member, so his #general thread works for a person in it; Sam may not edit it: the person's 403.
    expect([elsewhere.status, elsewhere.body.code]).toEqual([403, 'forbidden']);
    const convert = await call('PATCH', `/spaces/${ENG}`, keys.priyaEng, { visibility: 'private' });
    expect([convert.status, convert.body.code]).toEqual([403, 'session_bound_caller']);
    expect((await engRow()).visibility).toBe('public');
    const create = await call('POST', '/spaces', keys.priyaEng, { name: 'agent-made' });
    expect([create.status, create.body.code]).toEqual([403, 'session_bound_caller']);
  });
});
