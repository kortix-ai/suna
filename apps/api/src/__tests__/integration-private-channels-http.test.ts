/**
 * Integration test (real local DB, real routes): private channels.
 * Each test is named after the way a private thread could leak that it closes.
 *
 * People: MANAGER (project manager, not in P), ALICE (in P), BOB (project
 * member, not in P), OWNER (account owner with session oversight on, not in
 * P). P is a private channel written directly: creating one through the API
 * answers 409 `private_channels_unavailable` while `KORTIX_PRIVATE_CHANNELS_ENABLED` is off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  auditEvents,
  changeRequests,
  connectorCalls,
  notifications,
  projectMembers,
  projectSessions,
  projectSpaceLinks,
  projectSpaceMembers,
  projectSpaces,
  projects,
  serviceAccounts,
  sessionSandboxes,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../index';
import { invalidateSessionOversight } from '../iam/session-oversight';
import { loadSessionAccessRows, mayPromptSessions, maySeeSessions } from '../notifications/access';
import { markInboxRead } from '../notifications/inbox-read';
import { findForkSourceSpace, findSessionSpace, inheritedPrivateSpace, updateChannel } from '../projects/lib/project-spaces';
import { spaceAccessFor } from '../shared/space-access';
import { resolveTriggerSpace } from '../projects/lib/trigger-space';
import { createAccountToken } from '../repositories/account-tokens';
import { applyAdminOverride } from '../billing/services/account-write-owner';
import { recordAuditEvent, flushAuditEvents } from '../shared/audit';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SERVICE_ACCOUNT = crypto.randomUUID();
const USERS = [MANAGER, ALICE, BOB, OWNER];
const P = crypto.randomUUID();
const P_SLUG = `deals-${P.slice(0, 6)}`;
const ARCHIVED_P = crypto.randomUUID();
const PUBLIC_C = crypto.randomUUID();
const sid = () => crypto.randomUUID();
const THREAD = sid(); // alice's project-visible thread in P
const SIBLING = sid(); // another thread in P
const TRIGGER_RUN = sid(); // a trigger run in P
const GENERAL_THREAD = sid(); // alice's thread in #general
const ARCHIVED_THREAD = sid(); // a thread in an archived private channel
const PUBLIC_THREAD = sid(); // bob's thread in a public channel (converted below)
const WORD = `zebracorn${P.slice(0, 6)}`;
const minted: string[] = [];
const keys: Record<string, string> = {};
let general = '';
let pendingCall = '';

async function mint(userId: string, sessionId?: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'private-channels-test',
    agentGrant: null as any,
    ...(sessionId ? { sessionId } : {}),
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function req(method: string, path: string, secret: string, body?: unknown) {
  const res = await app.request(`/v1/projects/${PROJECT}${path}`, {
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

const listIds = async (secret: string, query = ''): Promise<string[]> => {
  const res = await req('GET', `/sessions${query}`, secret);
  if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`list ${query}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.map((s: any) => s.session_id);
};

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'private-channels', adminsSeeAllSessions: true });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'Northwind',
    repoUrl: 'https://example.test/n.git',
    metadata: { experimental: { project_channels: true } },
  });
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(db, accountMembers, [
    ...[MANAGER, ALICE, BOB].map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })),
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' as const, isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: ALICE, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: BOB, projectRole: 'member' },
  ]);
  await db.insert(serviceAccounts).values({
    serviceAccountId: SERVICE_ACCOUNT,
    accountId: ACCOUNT,
    name: 'nightly agent',
    secretHash: `h_${SERVICE_ACCOUNT}`,
    publicPrefix: `kortix_sa_${SERVICE_ACCOUNT.slice(0, 6)}`,
  });
  keys.manager = await mint(MANAGER);
  keys.alice = await mint(ALICE);
  keys.bob = await mint(BOB);
  keys.owner = await mint(OWNER);
  // #general exists after the first list.
  const spaces = await req('GET', '/spaces', keys.alice);
  general = spaces.body.spaces.find((s: any) => s.is_default).space_id;
  await db.insert(projectSpaces).values([
    { spaceId: P, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: P_SLUG, name: P_SLUG, createdBy: ALICE, visibility: 'private' },
    {
      spaceId: ARCHIVED_P,
      accountId: ACCOUNT,
      projectId: PROJECT,
      kind: 'channel',
      slug: `old-${P.slice(0, 6)}`,
      name: 'old',
      createdBy: ALICE,
      visibility: 'private',
      archivedAt: new Date(),
    },
    { spaceId: PUBLIC_C, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `ops-${P.slice(0, 6)}`, name: 'ops', createdBy: MANAGER },
  ]);
  await db.insert(projectSpaceMembers).values([
    { spaceId: P, userId: ALICE, addedBy: ALICE },
    { spaceId: ARCHIVED_P, userId: ALICE, addedBy: ALICE },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'kortix' };
  await db.insert(projectSessions).values([
    { ...base, sessionId: THREAD, branchName: THREAD, createdBy: ALICE, visibility: 'project', spaceId: P, metadata: { name: `${WORD} plan` } },
    { ...base, sessionId: SIBLING, branchName: SIBLING, createdBy: ALICE, visibility: 'project', spaceId: P, metadata: {} },
    {
      ...base,
      sessionId: TRIGGER_RUN,
      branchName: TRIGGER_RUN,
      createdBy: SERVICE_ACCOUNT,
      visibility: 'private',
      spaceId: P,
      origin: 'schedule',
      initiatorType: 'trigger',
      metadata: { trigger_kind: 'git', trigger_slug: 'nightly', source: 'trigger:cron' },
    },
    { ...base, sessionId: GENERAL_THREAD, branchName: GENERAL_THREAD, createdBy: ALICE, visibility: 'project', spaceId: general, metadata: {} },
    { ...base, sessionId: ARCHIVED_THREAD, branchName: ARCHIVED_THREAD, createdBy: ALICE, visibility: 'project', spaceId: ARCHIVED_P, metadata: {} },
    { ...base, sessionId: PUBLIC_THREAD, branchName: PUBLIC_THREAD, createdBy: BOB, visibility: 'project', spaceId: PUBLIC_C, metadata: {} },
  ]);
  // A session credential is valid only while its sandbox is live.
  await db.insert(sessionSandboxes).values(
    [GENERAL_THREAD, THREAD, TRIGGER_RUN].map((sessionId) => ({
      sandboxId: crypto.randomUUID(),
      sessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      externalId: `pc-${sessionId.slice(0, 8)}`,
      status: 'active' as const,
    })),
  );
  keys.generalToken = await mint(ALICE, GENERAL_THREAD);
  keys.pToken = await mint(ALICE, THREAD);
  // A trigger run's token: no human launcher, so P stays reachable whoever minted it.
  keys.runToken = await mint(MANAGER, TRIGGER_RUN);
  const [call] = await db
    .insert(connectorCalls)
    .values({ accountId: ACCOUNT, projectId: PROJECT, actionPath: 'mail.send', status: 'pending_approval', sessionId: THREAD, actingUserId: ALICE } as any)
    .returning({ executionId: connectorCalls.executionId });
  pendingCall = call!.executionId;
  await db.insert(changeRequests).values({
    accountId: ACCOUNT,
    projectId: PROJECT,
    number: 1,
    title: `${WORD} change`,
    baseRef: 'main',
    headRef: THREAD,
    originSessionId: THREAD,
    createdBy: ALICE,
  } as any);
  invalidateSessionOversight();
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.execute(sql`delete from kortix.service_accounts where account_id = ${ACCOUNT}::uuid`);
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});


describe('the channel and its tabs', () => {
  test('bob and a manager list no P; alice lists P as private', async () => {
    for (const key of [keys.bob, keys.manager, keys.owner]) {
      const res = await req('GET', '/spaces', key);
      expect(res.status).toBe(200);
      expect(res.body.spaces.map((s: any) => s.space_id)).not.toContain(P);
    }
    const alice = await req('GET', '/spaces', keys.alice);
    expect(alice.body.spaces.find((s: any) => s.space_id === P)).toMatchObject({ visibility: 'private', is_member: true });
    expect(alice.body.spaces.find((s: any) => s.space_id === general)).toMatchObject({ visibility: 'public' });
  });

  test('a guessed P id on every tab route is 404 space_not_found for bob; alice gets 200', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/spaces/${P}/links`],
      ['GET', `/spaces/${P}/apps`],
      ['GET', `/spaces/${P}/members`],
      ['POST', `/spaces/${P}/links`, { url: 'https://example.test/a' }],
      ['POST', `/spaces/${P}/join`],
      ['POST', `/spaces/${P}/members`, { user_ids: [BOB] }],
      ['DELETE', `/spaces/${P}/members/me`],
      ['PATCH', `/spaces/${P}`, { description: 'x' }],
    ];
    for (const [method, path, body] of routes) {
      const res = await req(method, path, keys.bob, body);
      expect({ method, path, status: res.status, code: res.body.code }).toEqual({ method, path, status: 404, code: 'space_not_found' });
    }
    for (const path of [`/spaces/${P}/links`, `/spaces/${P}/members`]) {
      expect((await req('GET', path, keys.alice)).status).toBe(200);
    }
    // No row was written for bob.
    const rows = await db.select().from(projectSpaceMembers).where(eq(projectSpaceMembers.spaceId, P));
    expect(rows.map((r) => r.userId)).toEqual([ALICE]);
  });

  test('a manager outside P lists and removes its members and renames it, adds others but never themself, and reads no content or joins', async () => {
    const members = await req('GET', `/spaces/${P}/members`, keys.manager);
    expect(members.status).toBe(200);
    expect(members.body.members.map((m: any) => m.user_id)).toEqual([ALICE]);
    // Owner decision 2026-10-26 (D1 manager list): a manager adds people, so a channel its last member left is not stuck.
    expect(members.body.can_add).toBe(true);
    const self = await req('POST', `/spaces/${P}/members`, keys.manager, { user_ids: [MANAGER] });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('manager_self_add');
    for (const [method, path, body] of [
      ['GET', `/spaces/${P}/links`],
      ['GET', `/spaces/${P}/apps`],
      ['POST', `/spaces/${P}/join`],
    ] as Array<[string, string, unknown?]>) {
      expect((await req(method, path, keys.manager, body)).status).toBe(404);
    }
    const renamed = await req('PATCH', `/spaces/${P}`, keys.manager, { name: P_SLUG });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ space_id: P, visibility: 'private', is_member: false, description: null, agents: [] });
    // nothing but name and archived.
    for (const body of [{ description: 'manager wrote this' }, { agents: [] }]) {
      expect((await req('PATCH', `/spaces/${P}`, keys.manager, body)).status).toBe(403);
    }
  });

  test('a session token cannot create, rename, archive, convert, join or change members of any channel', async () => {
    const attempts: Array<[string, string, unknown?]> = [
      ['PATCH', `/spaces/${P}`, { name: 'renamed-by-agent' }],
      ['PATCH', `/spaces/${P}`, { archived: true }],
      ['PATCH', `/spaces/${PUBLIC_C}`, { visibility: 'private' }],
      ['POST', `/spaces/${P}/members`, { user_ids: [BOB] }],
      ['DELETE', `/spaces/${P}/members/${ALICE}`],
      ['POST', `/spaces/${PUBLIC_C}/join`],
      ['POST', `/spaces/${PUBLIC_C}/members`, { user_ids: [BOB] }],
      // nor create one.
      ['POST', '/spaces', { name: `agent-made-${P.slice(0, 6)}` }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await req(method, path, keys.pToken, body);
      expect({ method, path, status: res.status, code: res.body.code }).toEqual({ method, path, status: 403, code: 'session_bound_caller' });
    }
    const [row] = await db.select().from(projectSpaces).where(eq(projectSpaces.spaceId, P));
    expect(row!.name).toBe(P_SLUG);
    expect(row!.archivedAt).toBeNull();
  });

  test('the token of a #general thread launched by alice sees no P; the token of a P thread sees P', async () => {
    expect((await req('GET', '/spaces', keys.generalToken)).body.spaces.map((s: any) => s.space_id)).not.toContain(P);
    expect((await req('GET', `/spaces/${P}/links`, keys.generalToken)).status).toBe(404);
    expect((await req('GET', '/spaces', keys.pToken)).body.spaces.map((s: any) => s.space_id)).toContain(P);
    expect((await req('GET', `/spaces/${P}/links`, keys.pToken)).status).toBe(200);
  });

  test('bob creating a channel with P\'s name gets 409 slug_taken with no id, no archived state, no edit right', async () => {
    const bob = await req('POST', '/spaces', keys.bob, { name: P_SLUG });
    expect(bob.status).toBe(409);
    expect(bob.body).toEqual({ error: `A channel is already named #${P_SLUG}.`, code: 'slug_taken' });
    const bobArchived = await req('POST', '/spaces', keys.bob, { name: `old-${P.slice(0, 6)}` });
    expect(bobArchived.body).toEqual({ error: `A channel is already named #old-${P.slice(0, 6)}.`, code: 'slug_taken' });
    const alice = await req('POST', '/spaces', keys.alice, { name: P_SLUG });
    expect(alice.status).toBe(409);
    expect(alice.body).toMatchObject({ code: 'slug_taken', space_id: P, can_edit: true, archived: false });
  });

  test('with private channels off, creating or converting to private answers 409 private_channels_unavailable and writes nothing', async () => {
    const created = await req('POST', '/spaces', keys.alice, { name: `secret-${P.slice(0, 6)}`, visibility: 'private' });
    expect(created).toMatchObject({ status: 409, body: { code: 'private_channels_unavailable' } });
    const [row] = await db.select().from(projectSpaces).where(and(eq(projectSpaces.projectId, PROJECT), eq(projectSpaces.slug, `secret-${P.slice(0, 6)}`)));
    expect(row).toBeUndefined();
    const converted = await req('PATCH', `/spaces/${PUBLIC_C}`, keys.manager, { visibility: 'private' });
    expect(converted).toMatchObject({ status: 409, body: { code: 'private_channels_unavailable' } });
    const publicCreate = await req('POST', '/spaces', keys.alice, { name: `open-${P.slice(0, 6)}`, visibility: 'public' });
    expect(publicCreate).toMatchObject({ status: 201, body: { visibility: 'public' } });
  });

  test('private to public is refused by the contract (400)', async () => {
    expect((await req('PATCH', `/spaces/${P}`, keys.alice, { visibility: 'public' })).status).toBe(400);
  });
});

describe('threads of P', () => {
  const sessionRoutes = ['', '/participants', '/memory-usage', '/message-authors', '/sharing', '/public-shares', '/events'];

  test('bob gets 404 on every session route of alice\'s P thread', async () => {
    for (const route of sessionRoutes) {
      const res = await req('GET', `/sessions/${THREAD}${route}`, keys.bob);
      expect({ route, status: res.status }).toEqual({ route, status: 404 });
    }
  });

  test('alice opens it, and its participants are P\'s members only', async () => {
    expect((await req('GET', `/sessions/${THREAD}`, keys.alice)).status).toBe(200);
    const participants = await req('GET', `/sessions/${THREAD}/participants`, keys.alice);
    expect(participants.status).toBe(200);
    expect(participants.body.participants.map((p: any) => p.user_id)).toEqual([ALICE]);
  });

  test('a manager gets 404 on alice\'s P thread and on a trigger run in P', async () => {
    for (const id of [THREAD, TRIGGER_RUN, ARCHIVED_THREAD]) {
      expect((await req('GET', `/sessions/${id}`, keys.manager)).status).toBe(404);
      expect((await req('GET', `/sessions/${id}/public-shares`, keys.manager)).status).toBe(404);
    }
  });

  test('the session list, space_id filter and q search hold no P thread for bob or a manager; alice gets them', async () => {
    for (const key of [keys.bob, keys.manager]) {
      expect(await listIds(key, `?space_id=${P}`)).toEqual([]);
      expect(await listIds(key, `?q=${WORD}`)).toEqual([]);
      const all = await listIds(key);
      for (const id of [THREAD, SIBLING, TRIGGER_RUN, ARCHIVED_THREAD]) expect(all).not.toContain(id);
    }
    expect((await listIds(keys.manager, '?scope=project')).some((id: string) => [THREAD, SIBLING, TRIGGER_RUN].includes(id as typeof THREAD))).toBe(false);
    expect(await listIds(keys.alice, `?q=${WORD}`)).toEqual([THREAD]);
    expect((await listIds(keys.alice, `?space_id=${P}`)).sort()).toEqual([THREAD, SIBLING].sort());
  });

  test('the #general thread token lists no P thread; the P thread token lists its siblings', async () => {
    const fromGeneral = await listIds(keys.generalToken);
    expect(fromGeneral).not.toContain(THREAD);
    expect(fromGeneral).not.toContain(SIBLING);
    expect((await req('GET', `/sessions/${SIBLING}`, keys.generalToken)).status).toBe(404);
    expect((await req('GET', `/sessions/${SIBLING}`, keys.pToken)).status).toBe(200);
  });

  test('S5 (filing): a new thread or fork lands in P only for its members and its own thread token', async () => {
    const access = (userId: string, bound: string | null) => spaceAccessFor(PROJECT, userId, bound);
    expect(await findSessionSpace(PROJECT, P, await access(BOB, null))).toBeNull();
    expect(await findSessionSpace(PROJECT, P, await access(MANAGER, null))).toBeNull();
    expect(await findSessionSpace(PROJECT, P, await access(ALICE, GENERAL_THREAD))).toBeNull();
    expect((await findSessionSpace(PROJECT, P, await access(ALICE, null)))?.spaceId).toBe(P);
    expect((await findSessionSpace(PROJECT, P, await access(ALICE, THREAD)))?.spaceId).toBe(P);
    expect(await findForkSourceSpace(PROJECT, THREAD, await access(BOB, null))).toBeNull();
    expect((await findForkSourceSpace(PROJECT, THREAD, await access(ALICE, null)))?.space.spaceId).toBe(P);
  });

  test('a fork or child (bound or body parent) of a P thread stays in P, a different space_id is 400, and a caller outside P (oversight included) gets 404', async () => {
    const as = async (userId: string, bound: string | null) => spaceAccessFor(PROJECT, userId, bound);
    // A member's fork lands in P.
    expect(await inheritedPrivateSpace(PROJECT, { forkFromSessionId: THREAD, parentSessionId: null, bodyParentSessionId: undefined, requestedSpaceId: undefined }, await as(ALICE, null)))
      .toEqual({ spaceId: P });
    // Asked into #general: refused, never filed elsewhere with the transcript.
    const elsewhere = await inheritedPrivateSpace(PROJECT, { forkFromSessionId: THREAD, parentSessionId: null, bodyParentSessionId: undefined, requestedSpaceId: general }, await as(ALICE, null));
    expect('error' in elsewhere! && elsewhere.error).toMatchObject({ status: 400, body: { code: 'private_channel_fork' } });
    // The oversight owner and a manager outside P: 404.
    for (const userId of [OWNER, MANAGER]) {
      const res = await inheritedPrivateSpace(PROJECT, { forkFromSessionId: THREAD, parentSessionId: null, bodyParentSessionId: undefined, requestedSpaceId: undefined }, await as(userId, null));
      expect('error' in res! && res.error.status).toBe(404);
    }
    // A P thread's token spawning a child into #general: refused.
    const child = await inheritedPrivateSpace(PROJECT, { forkFromSessionId: undefined, parentSessionId: THREAD, bodyParentSessionId: undefined, requestedSpaceId: general }, await as(ALICE, THREAD));
    expect('error' in child! && child.error.status).toBe(400);
    // a person's parent_session_id pointing at a P thread: same rule.
    const humanChild = await inheritedPrivateSpace(PROJECT, { forkFromSessionId: undefined, parentSessionId: null, bodyParentSessionId: THREAD, requestedSpaceId: general }, await as(ALICE, null));
    expect('error' in humanChild! && humanChild.error.status).toBe(400);
    expect(await inheritedPrivateSpace(PROJECT, { forkFromSessionId: undefined, parentSessionId: null, bodyParentSessionId: THREAD, requestedSpaceId: undefined }, await as(ALICE, null)))
      .toEqual({ spaceId: P });
    // A public source decides nothing.
    expect(await inheritedPrivateSpace(PROJECT, { forkFromSessionId: GENERAL_THREAD, parentSessionId: null, bodyParentSessionId: undefined, requestedSpaceId: undefined }, await as(BOB, null))).toBeNull();
  });

  test('a P thread\'s own agent token cannot mint a public share link of it; that is a person\'s decision', async () => {
    const res = await req('POST', `/sessions/${THREAD}/public-shares`, keys.pToken, { file: { path: '/workspace/a.md' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('session_bound_caller');
  });

  test('a manager outside P neither lists nor resolves P\'s pending connector actions; alice\'s needs-input counts them', async () => {
    const list = await req('GET', '/approvals', keys.manager);
    expect(list.status).toBe(200);
    expect(list.body.approvals.map((a: any) => a.execution_id)).not.toContain(pendingCall);
    const needs = await req('GET', '/approvals/needs-input', keys.manager);
    expect(needs.body.sessions[THREAD]).toBeUndefined();
    const resolve = await req('POST', `/approvals/${pendingCall}`, keys.manager, { decision: 'approve' });
    expect(resolve.status).toBe(404);
    const [row] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, pendingCall));
    expect(row!.status).toBe('pending_approval');
    expect((await req('GET', '/approvals/needs-input', keys.alice)).body.sessions[THREAD]).toBe(1);
  });

  test('the change request of a P thread is absent for a manager and present for alice', async () => {
    const titles = async (key: string) => ((await req('GET', '/change-requests?status=all', key)).body.change_requests ?? []).map((cr: any) => cr.title);
    expect(await titles(keys.manager)).not.toContain(`${WORD} change`);
    expect(await titles(keys.alice)).toContain(`${WORD} change`);
  });

  test('the project and account audit logs show a manager outside P no tool summary of a P thread, and q finds none', async () => {
    await applyAdminOverride(ACCOUNT, { tier: 'enterprise' }, { action: 'test.enterprise_plan.set' });
    await recordAuditEvent({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: THREAD,
      actorType: 'agent',
      action: 'opencode.tool.bash',
      resourceType: 'opencode_event',
      resourceId: crypto.randomUUID(),
      inputSummary: { command: `cat ${WORD}-secret.md` },
    } as any);
    await flushAuditEvents({ waitMs: 2_000 });
    const ofP = (events: any[]) => events.filter((e) => e.session_id === THREAD && e.action === 'opencode.tool.bash');
    const project = await req('GET', '/audit?limit=200', keys.manager);
    expect(project.status).toBe(200);
    expect(ofP(project.body.events).length).toBe(1);
    expect(ofP(project.body.events)[0].input_summary).toBeNull();
    expect(ofP((await req('GET', `/audit?q=${WORD}-secret`, keys.manager)).body.events)).toEqual([]);
    const ownerAccountToken = await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'private-channels-account', agentGrant: null as any });
    minted.push(ownerAccountToken.tokenId);
    const accountRes = await app.request(`/v1/accounts/${ACCOUNT}/audit?limit=200`, { headers: { Authorization: `Bearer ${ownerAccountToken.secretKey}` } });
    const accountBody = (await accountRes.json()) as any;
    expect(accountRes.status).toBe(200);
    expect(ofP(accountBody.events).length).toBe(1);
    expect(ofP(accountBody.events)[0].input_summary).toBeNull();
  });

  test('the account owner with oversight on opens a P thread, and the read is audited', async () => {
    expect((await req('GET', `/sessions/${THREAD}`, keys.owner)).status).toBe(200);
    const events = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, ACCOUNT), eq(auditEvents.action, 'project.admin_oversight_session_read')));
    expect(events.some((e: any) => e.resourceId === THREAD)).toBe(true);
  });
});

describe('notifications, triggers, removal', () => {
  test('bob is never told about a P thread; alice is', async () => {
    const rows = [...(await loadSessionAccessRows([THREAD])).values()];
    expect((await maySeeSessions(BOB, rows)).has(THREAD)).toBe(false);
    expect((await maySeeSessions(MANAGER, rows)).has(THREAD)).toBe(false);
    expect((await maySeeSessions(ALICE, rows)).has(THREAD)).toBe(true);
  });

  test('the oversight owner reads a P thread but may not prompt it through a room', async () => {
    const rows = [...(await loadSessionAccessRows([THREAD])).values()];
    expect((await maySeeSessions(OWNER, rows)).has(THREAD)).toBe(true);
    expect((await mayPromptSessions(OWNER, ACCOUNT, [THREAD])).has(THREAD)).toBe(false);
  });

  test('bob cannot point a trigger at P (404); alice can', async () => {
    const bob = await resolveTriggerSpace(PROJECT, P, { userId: BOB, bound: null });
    expect('error' in bob && bob.error.status).toBe(404);
    const alice = await resolveTriggerSpace(PROJECT, P, { userId: ALICE, bound: null });
    expect('space' in alice && alice.space.spaceId).toBe(P);
  });

  test('converting a public channel makes its creator, thread starters and link adders members, audited', async () => {
    await db.insert(projectSpaceLinks).values({ spaceId: PUBLIC_C, projectId: PROJECT, url: 'https://example.test/l', createdBy: ALICE });
    const viewer = { userId: MANAGER, manager: true, access: await spaceAccessFor(PROJECT, MANAGER, null) };
    const result = await updateChannel(PROJECT, viewer, PUBLIC_C, { visibility: 'private' });
    expect('space' in result && result.space.visibility).toBe('private');
    const members = await db.select().from(projectSpaceMembers).where(eq(projectSpaceMembers.spaceId, PUBLIC_C));
    expect(members.map((m) => m.userId).sort()).toEqual([MANAGER, ALICE, BOB].sort());
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, ACCOUNT), eq(auditEvents.action, 'space.visibility.changed')));
    expect(event).toBeDefined();
    // #general never becomes private.
    const refused = await updateChannel(PROJECT, viewer, general, { visibility: 'private' });
    expect('error' in refused && refused.error.body.code).toBe('default_channel');
    // The database refuses it too (project_spaces_private_channel_check).
    const direct = await db
      .update(projectSpaces)
      .set({ visibility: 'private' })
      .where(eq(projectSpaces.spaceId, general))
      .then(() => null, (error: any) => String(error?.cause?.constraint_name ?? error?.cause?.message ?? error?.message));
    expect(direct).toContain('project_spaces_private_channel_check');
  });

  test('a manager removes alice (P\'s creator) from P, and she loses every thread of it, her own included, at once', async () => {
    expect((await req('DELETE', `/spaces/${P}/members/${ALICE}`, keys.manager)).status).toBe(200);
    // Still in the archived private channel: one membership must not open another.
    const r = await req('GET', `/sessions/${THREAD}`, keys.alice);
    expect(r.status).toBe(404);
    expect((await req('GET', `/spaces/${P}/links`, keys.alice)).status).toBe(404);
    expect(await listIds(keys.alice, `?space_id=${P}`)).toEqual([]);
    const rows = [...(await loadSessionAccessRows([THREAD])).values()];
    expect((await maySeeSessions(ALICE, rows)).has(THREAD)).toBe(false);
  });

  test('marking a removed member\'s hidden P notifications read reports 0, not their count', async () => {
    const rows = await db
      .insert(notifications)
      .values([1, 2].map((n) => ({ userId: ALICE, accountId: ACCOUNT, projectId: PROJECT, sessionId: THREAD, kind: 'question', title: `P question ${n}` })))
      .returning({ id: notifications.notificationId });
    const byIds = await markInboxRead(ALICE, { ids: rows.map((r) => r.id) });
    expect(byIds.updated).toBe(0);
    await db.insert(notifications).values({ userId: ALICE, accountId: ACCOUNT, projectId: PROJECT, sessionId: THREAD, kind: 'question', title: 'P question 3' });
    expect((await markInboxRead(ALICE, { sessionId: THREAD })).updated).toBe(0);
  });

  test('after alice\'s removal her P-thread token lists nothing of P, opens nothing of P and cannot rejoin', async () => {
    expect(await listIds(keys.pToken, `?space_id=${P}`)).toEqual([]);
    expect((await req('GET', `/sessions/${THREAD}`, keys.pToken)).status).toBe(404);
    expect((await req('GET', `/sessions/${SIBLING}`, keys.pToken)).status).toBe(404);
    expect((await req('GET', `/spaces/${P}/links`, keys.pToken)).status).toBe(404);
    expect((await req('GET', '/spaces', keys.pToken)).body.spaces.map((s: any) => s.space_id)).not.toContain(P);
    expect((await req('POST', `/spaces/${P}/join`, keys.pToken)).status).toBe(403);
    expect((await req('POST', `/spaces/${P}/members`, keys.pToken, { user_ids: [ALICE] })).status).toBe(403);
    const rows = await db.select().from(projectSpaceMembers).where(and(eq(projectSpaceMembers.spaceId, P), eq(projectSpaceMembers.userId, ALICE)));
    expect(rows).toEqual([]);
  });

  test('a trigger run\'s token in P keeps its own thread and its channel (no human launcher to remove)', async () => {
    expect((await req('GET', `/sessions/${TRIGGER_RUN}`, keys.runToken)).status).toBe(200);
    expect((await req('GET', `/spaces/${P}/links`, keys.runToken)).status).toBe(200);
  });
});
