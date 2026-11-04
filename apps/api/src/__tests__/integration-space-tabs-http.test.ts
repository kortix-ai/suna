/**
 * Integration test (real local DB, real routes): `PUT /spaces/:spaceId/tabs`,
 * a space's free tabs after Chat.
 *
 * - The whole ordered list replaces the stored one, and the spaces list reads it back.
 * - Chat, `threads` and `memory` are not storable, at most 20 tabs, every
 *   tab needs a `ref`; a `file` tab takes a Drive path.
 * - A stored row of a removed kind is dropped on read.
 * - A link tab's `embeddable` is the server's: a page that refuses framing,
 *   one that fails, or a private address is false (a private address is
 *   never fetched); a plain 200 is true; an unchanged URL is not fetched again.
 * - A person who may not edit the channel gets 403; a DM's owner edits their DM;
 *   another member's DM is 404.
 * - A session token of a thread in the space may; one working for a person in
 *   the space may; one working for someone outside it gets 403.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as realDns from 'node:dns/promises';
import { accountMembers, accounts, projectMembers, projectSessions, projectSpaceMembers, projectSpaces, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

// The link probe resolves through the SSRF guard: `*.test` hosts resolve to
// the addresses below, every other name resolves for real.
const realLookup = realDns.lookup;
const ADDRESSES: Record<string, string> = {
  'framed.test': '93.184.216.34',
  'denied.test': '93.184.216.35',
  'csp.test': '93.184.216.36',
  'nohead.test': '93.184.216.37',
  'down.test': '93.184.216.38',
  'internal.test': '10.0.0.5',
};
mock.module('node:dns/promises', () => ({
  ...realDns,
  lookup: async (host: string, opts: unknown) => {
    const address = ADDRESSES[host];
    if (address) return [{ address, family: 4 }];
    if (host.endsWith('.test')) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return (realLookup as (h: string, o: unknown) => Promise<unknown>)(host, opts);
  },
}));
/** Every outbound request the probe made: method and the Host it asked for. */
const probes: string[] = [];
const realFetch = globalThis.fetch;
const PAGES: Record<string, (method: string) => { status: number; headers?: Record<string, string> }> = {
  'framed.test': () => ({ status: 200 }),
  'denied.test': () => ({ status: 200, headers: { 'x-frame-options': 'DENY' } }),
  'csp.test': () => ({ status: 200, headers: { 'content-security-policy': "frame-ancestors 'self'" } }),
  'nohead.test': (method) => (method === 'HEAD' ? { status: 405 } : { status: 200 }),
  'down.test': () => ({ status: 503 }),
};
function stubOutbound() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new Headers(init?.headers).get('host') ?? new URL(String(input)).host;
    const method = (init?.method ?? 'GET').toUpperCase();
    probes.push(`${method} ${host}`);
    const page = PAGES[host]?.(method) ?? { status: 404 };
    return new Response(null, { status: page.status, headers: page.headers });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

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
  { id: 'page', title: 'Launch page', kind: 'file', ref: '/Company/Channels/eng/launch.html' },
  { id: 'roadmap', title: 'Roadmap', kind: 'artifact', ref: 'art_roadmap' },
  // `.test` names other than the stubbed ones do not resolve: not embeddable, no request.
  { id: 'docs', title: 'Docs', kind: 'link', ref: 'https://example.test/docs', embeddable: false },
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
    expect(reordered.body.tabs.map((t: any) => t.id)).toEqual(['docs', 'page']);
  });

  test('Chat, threads and memory are not storable, at most 20 tabs, every tab needs a ref: 400', async () => {
    for (const kind of ['chat', 'threads', 'memory']) {
      expect((await put(ENG, keys.manager, [{ id: 'c', title: 'C', kind }])).status).toBe(400);
    }
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, kind: 'app', ref: 'crm' }));
    expect((await put(ENG, keys.manager, many)).status).toBe(400);
    expect((await put(ENG, keys.manager, many.slice(0, 20))).status).toBe(200);
    for (const kind of ['file', 'folder', 'artifact', 'app', 'link']) {
      expect((await put(ENG, keys.manager, [{ id: 'x', title: 'X', kind }])).status).toBe(400);
    }
    expect((await put(ENG, keys.manager, [{ id: 'x', title: 'X', kind: 'file', ref: 'launch.html' }])).status).toBe(400);
  });

  test('a stored row of a removed kind (threads, memory) is dropped on read', async () => {
    await db
      .update(projectSpaces)
      .set({ tabs: [{ id: 'old', title: 'Threads', kind: 'threads' }, { id: 'mem', title: 'Memory', kind: 'memory' }, TABS[1]!] as any })
      .where(eq(projectSpaces.spaceId, ENG));
    const list = await app.request(`/v1/projects/${PROJECT}/spaces`, { headers: { Authorization: `Bearer ${keys.manager}` } });
    const eng = ((await list.json()) as any).spaces.find((s: any) => s.space_id === ENG);
    expect(eng.tabs).toEqual([TABS[1]]);
  });

  test('a member who may not edit the channel gets 403 forbidden, and nothing changes', async () => {
    await put(ENG, keys.manager, TABS);
    const res = await put(ENG, keys.priya, []);
    expect(res).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    const [row] = await db.select({ tabs: projectSpaces.tabs }).from(projectSpaces).where(eq(projectSpaces.spaceId, ENG));
    expect(row!.tabs).toEqual(TABS as any);
  });

  test('a DM owner edits their DM; another member gets 404 space_not_found', async () => {
    const own = await put(PRIYA_DM, keys.priya, [{ id: 'notes', title: 'Notes', kind: 'file', ref: '/Users/priya/Agents/kortix/notes.md' }]);
    expect(own.status).toBe(200);
    expect(own.body.tabs).toEqual([{ id: 'notes', title: 'Notes', kind: 'file', ref: '/Users/priya/Agents/kortix/notes.md' }]);
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

describe('a link tab', () => {
  const link = (id: string, host: string, extra: Record<string, unknown> = {}) => ({ id, title: host, kind: 'link', ref: `https://${host}/page`, ...extra });

  test('embeddable is computed on save: a plain 200 is true; X-Frame-Options DENY, frame-ancestors self, or a 503 is false', async () => {
    stubOutbound();
    probes.length = 0;
    // A request that claims embeddable is not believed.
    const res = await put(ENG, keys.manager, [
      link('a', 'framed.test'),
      link('b', 'denied.test', { embeddable: true }),
      link('c', 'csp.test', { embeddable: true }),
      link('d', 'down.test', { embeddable: true }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.tabs.map((t: any) => [t.id, t.embeddable])).toEqual([['a', true], ['b', false], ['c', false], ['d', false]]);
    // One HEAD each; the 503 is retried once with GET.
    expect(probes.sort()).toEqual(['GET down.test', 'HEAD csp.test', 'HEAD denied.test', 'HEAD down.test', 'HEAD framed.test']);
    const [row] = await db.select({ tabs: projectSpaces.tabs }).from(projectSpaces).where(eq(projectSpaces.spaceId, ENG));
    expect(row!.tabs.map((t) => t.embeddable)).toEqual([true, false, false, false]);
  });

  test('a site that refuses HEAD is read with one GET', async () => {
    stubOutbound();
    probes.length = 0;
    const res = await put(ENG, keys.manager, [link('e', 'nohead.test')]);
    expect(res.body.tabs[0].embeddable).toBe(true);
    expect(probes).toEqual(['HEAD nohead.test', 'GET nohead.test']);
  });

  test('a URL already stored is not fetched again on rename or reorder; its value is kept', async () => {
    stubOutbound();
    await put(ENG, keys.manager, [link('a', 'framed.test'), link('b', 'denied.test')]);
    probes.length = 0;
    const res = await put(ENG, keys.manager, [link('b', 'denied.test', { title: 'Renamed', embeddable: true }), link('a', 'framed.test')]);
    expect(res.body.tabs.map((t: any) => [t.id, t.embeddable])).toEqual([['b', false], ['a', true]]);
    expect(probes).toEqual([]);
  });

  test('a private address or an IP literal of one is never fetched and is not embeddable', async () => {
    stubOutbound();
    probes.length = 0;
    const res = await put(ENG, keys.manager, [link('p', 'internal.test'), link('q', '127.0.0.1'), link('r', '169.254.169.254')]);
    expect(res.status).toBe(200);
    expect(res.body.tabs.map((t: any) => t.embeddable)).toEqual([false, false, false]);
    expect(probes).toEqual([]);
  });
});
