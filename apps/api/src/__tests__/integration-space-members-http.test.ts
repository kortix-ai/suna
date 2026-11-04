/**
 * Integration test (real local DB, real routes): channel membership for public
 * channels.
 *
 * - A channel create makes the creator a member, plus the people it names.
 * - `POST /members` adds people in one request; only project members.
 * - `GET /members` is the same set for every viewer; names never carry an email.
 * - `DELETE /members/:userId`: a member leaves, the creator removes others, only
 *   a manager removes the creator.
 * - `POST /join`: a non-member of a public channel joins.
 * - `#general`: every project member, implicitly; nobody added, nobody leaves.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectMembers, projectSpaceMembers, projects } from '@kortix/db';
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
/** An account member with no access to PROJECT. */
const OUTSIDER = crypto.randomUUID();
/** No such user anywhere. */
const STRANGER = crypto.randomUUID();
const USERS = [
  [MANAGER, 'Mara Manager'],
  [PRIYA, 'Priya Rao'],
  [SAM, null],
  [OUTSIDER, 'Otto Outside'],
] as const;
const minted: string[] = [];
const keys: Record<string, string> = {};

async function mint(userId: string): Promise<string> {
  const t = await createAccountToken({ accountId: ACCOUNT, userId, projectId: PROJECT, name: 'space-members-test', agentGrant: null as any });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function req(method: string, path: string, secret: string, body?: unknown) {
  const res = await app.request(`/v1/projects/${PROJECT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const ids = (list: { members: { user_id: string }[] }) => list.members.map((m) => m.user_id).sort();
const sorted = (...values: string[]) => [...values].sort();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'space-members' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'Northwind',
    repoUrl: 'https://example.test/n.git',
    metadata: { experimental: { project_channels: true } },
  });
  for (const [id, name] of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${JSON.stringify(name ? { full_name: name } : {})}::jsonb)`);
  }
  await insertIntoView(
    db,
    accountMembers,
    USERS.map(([userId]) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })),
  );
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: PRIYA, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: SAM, projectRole: 'member' },
  ]);
  keys.manager = await mint(MANAGER);
  keys.priya = await mint(PRIYA);
  keys.sam = await mint(SAM);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const [id] of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

let design = '';
let ops = '';

describe('a channel create', () => {
  test('makes the creator a member, plus the people it names', async () => {
    const created = await req('POST', '/spaces', keys.manager, { name: 'design', member_ids: [PRIYA] });
    expect(created.status).toBe(201);
    expect(created.body.is_member).toBe(true);
    design = created.body.space_id;
    const list = await req('GET', `/spaces/${design}/members`, keys.manager);
    expect(list.status).toBe(200);
    expect(ids(list.body)).toEqual(sorted(MANAGER, PRIYA));
    expect(list.body).toMatchObject({ implicit: false, can_add: true });
    expect(list.body.members[0]).toMatchObject({ user_id: MANAGER, is_viewer: true, is_creator: true, name: 'Mara Manager' });
  });

  test('naming someone outside the project is 400 not_project_member, and no channel is made', async () => {
    const res = await req('POST', '/spaces', keys.manager, { name: 'leaky', member_ids: [OUTSIDER] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_project_member');
    const spaces = await req('GET', '/spaces', keys.manager);
    expect(spaces.body.spaces.map((s: any) => s.slug)).not.toContain('leaky');
  });
});

describe('adding people', () => {
  test('the creator adds a project member in one request; names never carry an email', async () => {
    const res = await req('POST', `/spaces/${design}/members`, keys.manager, { user_ids: [SAM, PRIYA] });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(sorted(MANAGER, PRIYA, SAM));
    for (const member of res.body.members) expect(member.name).not.toContain('@');
    // No display name: the email's local part.
    expect(res.body.members.find((m: any) => m.user_id === SAM).name).toBe(SAM.slice(0, 8));
  });

  test('an account member without project access and an unknown id are 400 not_project_member; nobody is added', async () => {
    for (const id of [OUTSIDER, STRANGER]) {
      const res = await req('POST', `/spaces/${design}/members`, keys.priya, { user_ids: [id] });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'not_project_member', user_ids: [id] });
    }
    const rows = await db.select().from(projectSpaceMembers).where(eq(projectSpaceMembers.spaceId, design));
    expect(rows.map((r) => r.userId).sort()).toEqual(sorted(MANAGER, PRIYA, SAM));
  });

  test('every viewer reads the same people', async () => {
    const [a, b, c] = await Promise.all([
      req('GET', `/spaces/${design}/members`, keys.manager),
      req('GET', `/spaces/${design}/members`, keys.priya),
      req('GET', `/spaces/${design}/members`, keys.sam),
    ]);
    expect(ids(a.body)).toEqual(ids(b.body));
    expect(ids(b.body)).toEqual(ids(c.body));
  });
});

describe('leaving and joining', () => {
  test('a member leaves (`me`); the spaces list then says they are not a member', async () => {
    const res = await req('DELETE', `/spaces/${design}/members/me`, keys.sam);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(sorted(MANAGER, PRIYA));
    expect(res.body.can_add).toBe(false);
    const spaces = await req('GET', '/spaces', keys.sam);
    const row = spaces.body.spaces.find((s: any) => s.space_id === design);
    expect(row.is_member).toBe(false);
    expect(spaces.body.spaces.find((s: any) => s.is_default).is_member).toBe(true);
  });

  test('a non-member may not add people: 403 forbidden', async () => {
    const res = await req('POST', `/spaces/${design}/members`, keys.sam, { user_ids: [SAM] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  test('a non-member joins the public channel, twice is a no-op', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await req('POST', `/spaces/${design}/join`, keys.sam);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(sorted(MANAGER, PRIYA, SAM));
    }
  });
});

describe('removing people', () => {
  test('a member removes only themself; only a manager removes the creator', async () => {
    const created = await req('POST', '/spaces', keys.priya, { name: 'ops', member_ids: [SAM] });
    expect(created.status).toBe(201);
    ops = created.body.space_id;

    const samRemovesCreator = await req('DELETE', `/spaces/${ops}/members/${PRIYA}`, keys.sam);
    expect(samRemovesCreator).toMatchObject({ status: 403, body: { code: 'creator_not_removable' } });
    const creatorLeaves = await req('DELETE', `/spaces/${ops}/members/${PRIYA}`, keys.priya);
    expect(creatorLeaves).toMatchObject({ status: 403, body: { code: 'creator_not_removable' } });

    const list = await req('GET', `/spaces/${ops}/members`, keys.priya);
    const samRow = list.body.members.find((m: any) => m.user_id === SAM);
    const priyaRow = list.body.members.find((m: any) => m.user_id === PRIYA);
    expect(samRow.can_remove).toBe(true);
    expect(priyaRow.can_remove).toBe(false);

    const creatorRemovesSam = await req('DELETE', `/spaces/${ops}/members/${SAM}`, keys.priya);
    expect(creatorRemovesSam.status).toBe(200);
    expect(ids(creatorRemovesSam.body)).toEqual([PRIYA]);

    const managerRemovesCreator = await req('DELETE', `/spaces/${ops}/members/${PRIYA}`, keys.manager);
    expect(managerRemovesCreator.status).toBe(200);
    expect(ids(managerRemovesCreator.body)).toEqual([]);
  });

  test('a member may not remove another member: 403 forbidden', async () => {
    const res = await req('DELETE', `/spaces/${design}/members/${SAM}`, keys.priya);
    expect(res).toMatchObject({ status: 403, body: { code: 'forbidden' } });
  });
});

describe('#general', () => {
  test('lists every project member implicitly; nobody is added, joins or leaves', async () => {
    const spaces = await req('GET', '/spaces', keys.sam);
    const general = spaces.body.spaces.find((s: any) => s.is_default).space_id;
    const list = await req('GET', `/spaces/${general}/members`, keys.sam);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ implicit: true, can_add: false });
    expect(ids(list.body)).toEqual(sorted(MANAGER, PRIYA, SAM));
    expect(list.body.members.every((m: any) => m.can_remove === false)).toBe(true);
    for (const [method, path, body] of [
      ['POST', `/spaces/${general}/members`, { user_ids: [SAM] }],
      ['POST', `/spaces/${general}/join`, undefined],
      ['DELETE', `/spaces/${general}/members/${SAM}`, undefined],
    ] as const) {
      const res = await req(method, path, keys.manager, body);
      expect(res).toMatchObject({ status: 400, body: { code: 'default_channel' } });
    }
  });
});
