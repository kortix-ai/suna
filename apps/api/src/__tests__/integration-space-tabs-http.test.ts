/**
 * Integration test (real local DB, real routes): `PUT /spaces/:spaceId/tabs`,
 * a space's free tabs after Chat.
 *
 * - The whole ordered list replaces the stored one, and the spaces list reads it back.
 * - Chat is not storable, at most 20 tabs, `ref` required for artifact/app/folder/link.
 * - A person who may not edit the channel gets 403; a DM's owner edits their DM;
 *   another member's DM is 404.
 * - A session token of a thread in the space may; one working for a person in
 *   the space may; one working for someone outside it gets 403.
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
const PRIYA_DM = crypto.randomUUID();
const ENG_THREAD = crypto.randomUUID();
const PRIYA_GENERAL_THREAD = crypto.randomUUID();
const SAM_GENERAL_THREAD = crypto.randomUUID();
const USERS = [MANAGER, PRIYA, SAM] as const;
const minted: string[] = [];
const keys: Record<string, string> = {};

async function mint(userId: string, sessionId?: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'space-tabs-test',
    agentGrant: null as any,
    ...(sessionId ? { sessionId } : {}),
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function put(spaceId: string, secret: string, tabs: unknown) {
  const res = await app.request(`/v1/projects/${PROJECT}/spaces/${spaceId}/tabs`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tabs }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const TABS = [
  { id: 'threads', title: 'Threads', kind: 'threads' },
  { id: 'roadmap', title: 'Roadmap', kind: 'artifact', ref: 'art_roadmap' },
  { id: 'docs', title: 'Docs', kind: 'link', ref: 'https://example.test/docs' },
];

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'space-tabs' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'Tabs',
    repoUrl: 'https://example.test/t.git',
    metadata: { experimental: { chat: true } },
  });
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(
    db,
    accountMembers,
    USERS.map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })),
  );
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: PRIYA, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: SAM, projectRole: 'member' },
  ]);
  keys.manager = await mint(MANAGER);
  keys.priya = await mint(PRIYA);
  keys.sam = await mint(SAM);
  // `#general` is made by the first spaces read.
  const list = await app.request(`/v1/projects/${PROJECT}/spaces`, { headers: { Authorization: `Bearer ${keys.manager}` } });
  const general = ((await list.json()) as any).spaces.find((s: any) => s.is_default).space_id as string;
  await db.insert(projectSpaces).values([
    { spaceId: ENG, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `eng-${ENG.slice(0, 6)}`, name: 'eng', createdBy: MANAGER },
    { spaceId: PRIYA_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'kortix', dmUserId: PRIYA, dmAgentName: 'kortix', createdBy: PRIYA },
  ]);
  await db.insert(projectSpaceMembers).values([
    { spaceId: ENG, userId: MANAGER, addedBy: MANAGER },
    { spaceId: ENG, userId: PRIYA, addedBy: MANAGER },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'kortix', visibility: 'project', metadata: {} } as const;
  await db.insert(projectSessions).values([
    { ...base, sessionId: ENG_THREAD, branchName: ENG_THREAD, createdBy: SAM, spaceId: ENG },
    { ...base, sessionId: PRIYA_GENERAL_THREAD, branchName: PRIYA_GENERAL_THREAD, createdBy: PRIYA, spaceId: general },
    { ...base, sessionId: SAM_GENERAL_THREAD, branchName: SAM_GENERAL_THREAD, createdBy: SAM, spaceId: general },
  ]);
  // A session credential is valid only while its sandbox is live.
  await db.insert(sessionSandboxes).values(
    [ENG_THREAD, PRIYA_GENERAL_THREAD, SAM_GENERAL_THREAD].map((sessionId) => ({
      sandboxId: crypto.randomUUID(),
      sessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      externalId: `st-${sessionId.slice(0, 8)}`,
      status: 'active' as const,
    })),
  );
  keys.engThread = await mint(SAM, ENG_THREAD);
  keys.priyaGeneralThread = await mint(PRIYA, PRIYA_GENERAL_THREAD);
  keys.samGeneralThread = await mint(SAM, SAM_GENERAL_THREAD);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

describe('a person', () => {
  test('the channel creator replaces the list, and the spaces list reads it back in order', async () => {
    const res = await put(ENG, keys.manager, TABS);
    expect(res.status).toBe(200);
    expect(res.body.tabs).toEqual(TABS);
    const list = await app.request(`/v1/projects/${PROJECT}/spaces`, { headers: { Authorization: `Bearer ${keys.priya}` } });
    const eng = ((await list.json()) as any).spaces.find((s: any) => s.space_id === ENG);
    expect(eng.tabs).toEqual(TABS);
    // Reorder and remove in one call.
    const reordered = await put(ENG, keys.manager, [TABS[2], TABS[0]]);
    expect(reordered.body.tabs.map((t: any) => t.id)).toEqual(['docs', 'threads']);
  });

  test('Chat is not storable, at most 20 tabs, and artifact/app/folder/link need a ref: 400', async () => {
    expect((await put(ENG, keys.manager, [{ id: 'c', title: 'Chat', kind: 'chat' }])).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, kind: 'threads' }));
    expect((await put(ENG, keys.manager, many)).status).toBe(400);
    expect((await put(ENG, keys.manager, many.slice(0, 20))).status).toBe(200);
    for (const kind of ['artifact', 'app', 'folder', 'link']) {
      expect((await put(ENG, keys.manager, [{ id: 'x', title: 'X', kind }])).status).toBe(400);
    }
  });

  test('a member who may not edit the channel gets 403 forbidden, and nothing changes', async () => {
    await put(ENG, keys.manager, TABS);
    const res = await put(ENG, keys.priya, []);
    expect(res).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    const [row] = await db.select({ tabs: projectSpaces.tabs }).from(projectSpaces).where(eq(projectSpaces.spaceId, ENG));
    expect(row!.tabs).toEqual(TABS as any);
  });

  test('a DM owner edits their DM; another member gets 404 space_not_found', async () => {
    const own = await put(PRIYA_DM, keys.priya, [{ id: 'mem', title: 'Memory', kind: 'memory' }]);
    expect(own.status).toBe(200);
    expect(own.body.tabs).toEqual([{ id: 'mem', title: 'Memory', kind: 'memory' }]);
    expect(await put(PRIYA_DM, keys.sam, [])).toMatchObject({ status: 404, body: { code: 'space_not_found' } });
  });
});

describe('a session token', () => {
  test('of a thread filed in the space may, even when its person is not in it', async () => {
    const res = await put(ENG, keys.engThread, [TABS[0]]);
    expect(res.status).toBe(200);
    expect(res.body.tabs).toEqual([TABS[0]]);
  });

  test('working for a member of the space (or the DM owner) may, from another space', async () => {
    expect((await put(ENG, keys.priyaGeneralThread, TABS)).status).toBe(200);
    expect((await put(PRIYA_DM, keys.priyaGeneralThread, [])).status).toBe(200);
  });

  test('working for someone outside the space gets 403 forbidden; another person\'s DM is 404', async () => {
    expect(await put(ENG, keys.samGeneralThread, [])).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect((await put(PRIYA_DM, keys.samGeneralThread, [])).status).toBe(404);
  });
});
