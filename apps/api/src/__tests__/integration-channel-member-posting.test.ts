/**
 * Integration test (real local DB, real routes): channel members can post
 * (owner decision 2026-10-26), and the manager tools for private channels.
 *
 * People: OWNER (account owner), MANAGER (project manager), MEMBER and BOB
 * (project `member` role, no agent grant at all). Agents are deny-by-default
 * for a member, so before the decision MEMBER could not prompt anything.
 *
 * - A channel's agents (else the project default) run for whoever may post in
 *   the channel: `#general`, a public channel, a private one they are in.
 * - Nothing widens outside a channel: a thread in no space, another agent in
 *   the channel, a private channel they are not in, the flag off.
 * - A manager who converts a channel to private is a member after.
 * - Managers list the private channels they are not in, and add people to one
 *   its last member left (never themselves).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectMembers, projectSessions, projectSpaceMembers, projectSpaces, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../index';
import { actorForUser } from '../iam/actor';
import { resolveAndAuthorizeAgentAs } from '../projects/lib/agent-access';
import { updateChannel } from '../projects/lib/project-spaces';
import { spaceAccessFor } from '../shared/space-access';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const FLAG_OFF_PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const BOB = crypto.randomUUID();
const USERS = [OWNER, MANAGER, MEMBER, BOB];
const LEGAL = crypto.randomUUID(); // public, agents ['legal']
const P_IN = crypto.randomUUID(); // private, MEMBER is in it
const P_OUT = crypto.randomUUID(); // private, only BOB
const ORPHAN = crypto.randomUUID(); // private, nobody left
const CONVERT = crypto.randomUUID(); // public, converted by MANAGER who never posted
const sid = () => crypto.randomUUID();
const S = { general: sid(), legal: sid(), pIn: sid(), pOut: sid(), noSpace: sid(), flagOff: sid() };
const minted: string[] = [];
const keys: Record<string, string> = {};
let general = '';

async function mint(userId: string): Promise<string> {
  const t = await createAccountToken({ accountId: ACCOUNT, userId, name: 'channel-posting-test', agentGrant: null as any });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function req(method: string, path: string, secret: string, body?: unknown, project = PROJECT) {
  const res = await app.request(`/v1/projects/${project}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

const wireMessageId = () => `msg_${Date.now().toString(16).padStart(12, '0').slice(-12)}aAbBcCdDeEfF12`;
const prompt = (sessionId: string, secret: string, agent?: string, project = PROJECT) =>
  req(
    'POST',
    `/sessions/${sessionId}/prompts`,
    secret,
    {
      client_message_id: crypto.randomUUID(),
      message_id: wireMessageId(),
      parts: [{ type: 'text', text: 'hello team' }],
      ...(agent ? { overrides: { agent } } : {}),
    },
    project,
  );

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'channel-posting' });
  const metadata = { experimental: { project_channels: true }, default_agent: 'kortix' };
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'Posting', repoUrl: 'https://example.test/p.git', metadata },
    { projectId: FLAG_OFF_PROJECT, accountId: ACCOUNT, name: 'Off', repoUrl: 'https://example.test/o.git', metadata: { default_agent: 'kortix' } },
  ]);
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' as const, isSuperAdmin: false },
    ...[MANAGER, MEMBER, BOB].map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })),
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: BOB, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: FLAG_OFF_PROJECT, userId: MEMBER, projectRole: 'member' },
  ]);
  for (const id of USERS) keys[id] = await mint(id);
  const spaces = await req('GET', '/spaces', keys[OWNER]!);
  general = spaces.body.spaces.find((s: any) => s.is_default).space_id;
  const channel = (spaceId: string, slug: string, extra: Record<string, unknown> = {}) => ({
    spaceId, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel' as const, slug: `${slug}-${spaceId.slice(0, 6)}`, name: slug, createdBy: OWNER, ...extra,
  });
  await db.insert(projectSpaces).values([
    channel(LEGAL, 'legal', { agents: ['legal'] }),
    channel(P_IN, 'deals', { visibility: 'private' }),
    channel(P_OUT, 'board', { visibility: 'private', createdBy: BOB }),
    channel(ORPHAN, 'orphan', { visibility: 'private', createdBy: null }),
    channel(CONVERT, 'ops'),
  ]);
  await db.insert(projectSpaceMembers).values([
    { spaceId: P_IN, userId: MEMBER, addedBy: OWNER },
    { spaceId: P_IN, userId: OWNER, addedBy: OWNER },
    { spaceId: P_OUT, userId: BOB, addedBy: BOB },
  ]);
  const thread = (sessionId: string, spaceId: string | null, agentName: string, projectId = PROJECT) => ({
    sessionId, accountId: ACCOUNT, projectId, branchName: sessionId, agentName, status: 'running' as const,
    createdBy: OWNER, visibility: 'project' as const, spaceId, metadata: {},
  });
  await db.insert(projectSessions).values([
    thread(S.general, general, 'kortix'),
    thread(S.legal, LEGAL, 'legal'),
    thread(S.pIn, P_IN, 'kortix'),
    thread(S.pOut, P_OUT, 'kortix'),
    thread(S.noSpace, null, 'kortix'),
    thread(S.flagOff, null, 'kortix', FLAG_OFF_PROJECT),
  ]);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

describe('a member with no agent grant posts in a channel', () => {
  test('a reply in #general queues on the project default agent (202)', async () => {
    const res = await prompt(S.general, keys[MEMBER]!);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'queued' });
  });

  test('a reply in a public channel queues on the channel’s agent (202)', async () => {
    expect((await prompt(S.legal, keys[MEMBER]!)).status).toBe(202);
  });

  test('a reply in a private channel they are in queues (202)', async () => {
    expect((await prompt(S.pIn, keys[MEMBER]!)).status).toBe(202);
  });

  test('another agent in the channel is still refused: 403 no access', async () => {
    const res = await prompt(S.legal, keys[MEMBER]!, 'kortix');
    expect(res.status).toBe(403);
    expect(res.body.code).toMatch(/agent_not_accessible|no_agent_access/);
  });

  test('outside channels nothing changes: a thread in no space is 403', async () => {
    const res = await prompt(S.noSpace, keys[MEMBER]!);
    expect(res.status).toBe(403);
    expect(res.body.code).toMatch(/agent_not_accessible|no_agent_access/);
  });

  test('a private channel they are not in stays hidden: 404', async () => {
    expect((await prompt(S.pOut, keys[MEMBER]!)).status).toBe(404);
  });

  test('with project_channels off, the agent grants alone decide: 403', async () => {
    const res = await prompt(S.flagOff, keys[MEMBER]!, undefined, FLAG_OFF_PROJECT);
    expect(res.status).toBe(403);
  });

  test('the create gate: a channel’s agent is approved for a member and binds; no space refuses', async () => {
    const actor = actorForUser(MEMBER, ACCOUNT);
    const [row] = await db.select().from(projects).where(eq(projects.projectId, PROJECT));
    const loaded = { row, userId: MEMBER };
    expect(await resolveAndAuthorizeAgentAs(actor, undefined, loaded, PROJECT, 'legal', undefined, undefined, LEGAL)).toMatchObject({
      agentName: 'legal',
      memberTier: true,
      viaChannel: true,
    });
    // #general lists no agents: the project default runs, unnamed.
    expect(await resolveAndAuthorizeAgentAs(actor, undefined, loaded, PROJECT, undefined, undefined, undefined, general)).toMatchObject({
      agentName: 'kortix',
      viaChannel: true,
    });
    await expect(resolveAndAuthorizeAgentAs(actor, undefined, loaded, PROJECT, 'legal')).rejects.toMatchObject({ status: 403 });
    await expect(
      resolveAndAuthorizeAgentAs(actor, undefined, loaded, PROJECT, 'kortix', undefined, undefined, P_OUT),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('managers and private channels', () => {
  test('a manager who never posted converts a channel and is a member after', async () => {
    const result = await updateChannel(
      PROJECT,
      { userId: MANAGER, manager: true, access: await spaceAccessFor(PROJECT, MANAGER, null) },
      CONVERT,
      { visibility: 'private' },
    );
    expect('space' in result && result.space.visibility).toBe('private');
    const rows = await db
      .select({ userId: projectSpaceMembers.userId })
      .from(projectSpaceMembers)
      .where(and(eq(projectSpaceMembers.spaceId, CONVERT), eq(projectSpaceMembers.userId, MANAGER)));
    expect(rows).toHaveLength(1);
  });

  test('GET /spaces/private lists the private channels a manager is not in: name, count, creator, no content', async () => {
    const res = await req('GET', '/spaces/private', keys[MANAGER]!);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.channels.map((c: any) => [c.space_id, c]));
    expect([...byId.keys()].sort()).toEqual([ORPHAN, P_IN, P_OUT].sort());
    expect(byId.get(P_IN)).toMatchObject({ name: 'deals', member_count: 2, created_by: OWNER, archived_at: null });
    expect(byId.get(ORPHAN)).toMatchObject({ member_count: 0, created_by: null, created_by_name: null });
    expect(Object.keys(byId.get(P_OUT) as object).sort()).toEqual(
      ['archived_at', 'created_at', 'created_by', 'created_by_name', 'member_count', 'name', 'slug', 'space_id'].sort(),
    );
  });

  test('GET /spaces/private is managers only: a member gets 403', async () => {
    const res = await req('GET', '/spaces/private', keys[MEMBER]!);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  test('a manager adds people to a channel its last member left, never themself', async () => {
    const members = await req('GET', `/spaces/${ORPHAN}/members`, keys[MANAGER]!);
    expect(members.status).toBe(200);
    expect(members.body.can_add).toBe(true);
    const self = await req('POST', `/spaces/${ORPHAN}/members`, keys[MANAGER]!, { user_ids: [MANAGER] });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('manager_self_add');
    const added = await req('POST', `/spaces/${ORPHAN}/members`, keys[MANAGER]!, { user_ids: [BOB] });
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: any) => m.user_id)).toEqual([BOB]);
    // BOB now sees it; the manager still does not.
    const bobSpaces = await req('GET', '/spaces', keys[BOB]!);
    expect(bobSpaces.body.spaces.some((s: any) => s.space_id === ORPHAN)).toBe(true);
    const managerSpaces = await req('GET', '/spaces', keys[MANAGER]!);
    expect(managerSpaces.body.spaces.some((s: any) => s.space_id === ORPHAN)).toBe(false);
  });

  test('a manager renames and archives a private channel from the list; a member outside cannot add', async () => {
    const renamed = await req('PATCH', `/spaces/${P_OUT}`, keys[MANAGER]!, { name: `board renamed ${P_OUT.slice(0, 4)}` });
    expect(renamed.status).toBe(200);
    const archived = await req('PATCH', `/spaces/${P_OUT}`, keys[MANAGER]!, { archived: true });
    expect(archived.status).toBe(200);
    const listed = await req('GET', '/spaces/private', keys[MANAGER]!);
    expect(listed.body.channels.find((c: any) => c.space_id === P_OUT)?.archived_at).not.toBeNull();
    expect((await req('POST', `/spaces/${P_IN}/members`, keys[BOB]!, { user_ids: [BOB] })).status).toBe(404);
  });
});
