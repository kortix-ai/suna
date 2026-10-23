/**
 * Integration test (real local DB, real routes): turning Channels on and off
 * (spec section 14, D7, D8).
 *
 * - D7: only a project admin (`project.settings.write`, the Manager role)
 *   turns `project_channels` on or off. A member gets 403 and nothing changes.
 * - Turn on again: sessions started while it was off are filed into
 *   `#general`, `GET /spaces` returns `general_notice`, and every member's
 *   intro is marked seen.
 * - `GET /onboarding/channels` and `POST /onboarding/channels/marks`: marks
 *   and facts (a channel created, memory saved in `#general`, a DM).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  memoryLayers,
  memoryPages,
  memoryPageVersions,
  projectMembers,
  projectSessions,
  projectSpaces,
  projects,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { runFeatureFlagToggleEffects } from '../feature-flags/toggle-effects';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OFF_PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
/** Joins the account after the turn-on again: no intro mark yet. */
const SAM = crypto.randomUUID();
const OFF_WHILE = crypto.randomUUID();
const minted: string[] = [];
const keys: Record<string, string> = {};

async function mint(userId: string, projectId = PROJECT): Promise<string> {
  const t = await createAccountToken({ accountId: ACCOUNT, userId, projectId, name: 'channels-onboarding-test', agentGrant: null as any });
  minted.push(t.tokenId);
  return t.secretKey;
}

function req(method: string, path: string, secret: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const base = `/v1/projects/${PROJECT}`;
const channelsMeta = async () =>
  ((await db.select({ m: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT)))[0]!.m as any)?.channels;

/** The toggle effect runs behind the PATCH response; wait for its record (fake clocks cannot reach a DB write). */
async function waitFor<T>(read: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'channels-onboarding' });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'Northwind', repoUrl: 'https://example.test/n.git', metadata: { experimental: { project_channels: true } } },
    { projectId: OFF_PROJECT, accountId: ACCOUNT, name: 'Acme', repoUrl: 'https://example.test/a.git' },
  ]);
  await insertIntoView(db, accountMembers, [
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: PRIYA, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: PRIYA, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: OFF_PROJECT, userId: PRIYA, projectRole: 'member' },
  ]);
  keys.manager = await mint(MANAGER);
  keys.priya = await mint(PRIYA);
  keys.priyaOff = await mint(PRIYA, OFF_PROJECT);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projectSessions).where(eq(projectSessions.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('D7: only a project admin turns Channels on or off', () => {
  test('a member gets 403 naming project.settings.write, and the flag stays on', async () => {
    const res = await req('PATCH', `${base}/features`, keys.priya, { feature: 'project_channels', enabled: false });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('(project.settings.write)');
    const [row] = await db.select({ m: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
    expect((row!.m as any).experimental.project_channels).toBe(true);
  });
});

describe('turning Channels on again', () => {
  test('the session started while off moves into #general, with the notice and no intro for anyone', async () => {
    // First on: `#general` exists (made on the first channel list).
    const first = await req('GET', `${base}/spaces`, keys.priya);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody.general_notice).toBeUndefined();
    const general = firstBody.spaces.find((space: any) => space.is_default);

    expect((await req('PATCH', `${base}/features`, keys.manager, { feature: 'project_channels', enabled: false })).status).toBe(200);
    await db.insert(projectSessions).values({ sessionId: OFF_WHILE, accountId: ACCOUNT, projectId: PROJECT, branchName: 'o', createdBy: PRIYA, agentName: 'kortix' });
    expect((await req('PATCH', `${base}/features`, keys.manager, { feature: 'project_channels', enabled: true })).status).toBe(200);

    const channels = await waitFor(channelsMeta);
    expect(channels.reenabled_count).toBe(1);
    const [session] = await db.select({ spaceId: projectSessions.spaceId }).from(projectSessions).where(eq(projectSessions.sessionId, OFF_WHILE));
    expect(session!.spaceId).toBe(general.space_id);

    const list = (await (await req('GET', `${base}/spaces`, keys.priya)).json()) as any;
    expect(list.general_notice).toEqual({ kind: 'reenabled', at: channels.reenabled_at, count: 1 });
    const onboarding = (await (await req('GET', `${base}/onboarding/channels`, keys.priya)).json()) as any;
    expect(onboarding.intro_seen).toBe(true);
  });

  test('a repeated "on" (on before the write too) records nothing new', async () => {
    const before = await channelsMeta();
    const on = { experimental: { project_channels: true } };
    await runFeatureFlagToggleEffects({ key: 'project_channels', projectId: PROJECT, accountId: ACCOUNT, metadata: on, previousMetadata: on });
    expect(await channelsMeta()).toEqual(before);
  });
});

describe('the onboarding state of one member', () => {
  const get = async () => {
    const res = await req('GET', `${base}/onboarding/channels`, keys.sam);
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    await insertIntoView(db, accountMembers, [{ userId: SAM, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false }]);
    await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId: PROJECT, userId: SAM, projectRole: 'member' }]);
    keys.sam = await mint(SAM);
  });

  test('a new member: intro not seen, all rows open, block visible', async () => {
    expect(await get()).toEqual({ intro_seen: false, get_started: { visible: true, create_channel: false, remember: false, open_dm: false } });
  });

  test('marks: 204, idempotent; an unknown mark is 400', async () => {
    expect((await req('POST', `${base}/onboarding/channels/marks`, keys.sam, { mark: 'channels_intro' })).status).toBe(204);
    expect((await req('POST', `${base}/onboarding/channels/marks`, keys.sam, { mark: 'channels_intro' })).status).toBe(204);
    expect((await req('POST', `${base}/onboarding/channels/marks`, keys.sam, { mark: 'tour' })).status).toBe(400);
    expect((await get()).intro_seen).toBe(true);
  });

  test('facts: a channel created, memory saved in #general, a DM; all three hide the block', async () => {
    expect((await req('POST', `${base}/spaces`, keys.sam, { name: 'launch' })).status).toBe(201);
    expect((await get()).get_started.create_channel).toBe(true);

    const [general] = await db.select().from(projectSpaces).where(and(eq(projectSpaces.projectId, PROJECT), eq(projectSpaces.isDefault, true)));
    const [layer] = await db.insert(memoryLayers).values({ projectId: PROJECT, scope: 'channel', spaceId: general!.spaceId, importedAt: new Date() }).returning();
    const [page] = await db
      .insert(memoryPages)
      .values({ layerId: layer!.layerId, projectId: PROJECT, type: 'note', title: 'Launch on Monday', titleKey: 'launch on monday' })
      .returning();
    await db.insert(memoryPageVersions).values({
      pageId: page!.pageId, layerId: layer!.layerId, versionNo: 1, changeId: crypto.randomUUID(), type: 'note', title: 'Launch on Monday',
      summary: '', body: '', status: 'confirmed', op: 'create', authorKind: 'person', authorUserId: SAM,
    });
    expect((await get()).get_started.remember).toBe(true);
    // Another member's memory does not count for Priya.
    expect(((await (await req('GET', `${base}/onboarding/channels`, keys.priya)).json()) as any).get_started.remember).toBe(false);

    await db.insert(projectSpaces).values({ accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'kortix', dmUserId: SAM, dmAgentName: 'kortix' });
    expect(await get()).toEqual({ intro_seen: true, get_started: { visible: false, create_channel: true, remember: true, open_dm: true } });
  });

  test('dismissed hides the block with rows still open', async () => {
    expect((await req('POST', `${base}/onboarding/channels/marks`, keys.priya, { mark: 'get_started.dismissed' })).status).toBe(204);
    const body = (await (await req('GET', `${base}/onboarding/channels`, keys.priya)).json()) as any;
    expect(body.get_started).toEqual({ visible: false, create_channel: false, remember: false, open_dm: false });
  });

  test('flag off: both routes answer 403 feature_disabled', async () => {
    const off = `/v1/projects/${OFF_PROJECT}/onboarding/channels`;
    for (const res of [await req('GET', off, keys.priyaOff), await req('POST', `${off}/marks`, keys.priyaOff, { mark: 'channels_intro' })]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).code).toBe('feature_disabled');
    }
  });
});
