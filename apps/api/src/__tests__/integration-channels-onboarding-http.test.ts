/**
 * Integration test (real local DB, real routes): turning Channels on and off.
 *
 * - Only a project admin (`project.settings.write`, the Manager role)
 *   turns `project_channels` on or off. A member gets 403 and nothing changes.
 *   (The other writer, `PUT /v1/admin/api/projects/:id/features`, is for
 *   platform operators only.)
 * - First turn-on: no "turned on again" record, even when `#general` is made
 *   by a channel list before the toggle effect runs.
 * - Turn on again: sessions started while it was off are filed into
 *   `#general`, `GET /spaces` returns `general_notice`, every project member's
 *   intro is marked seen (not an account member without project access), and
 *   a retry of the effect keeps the count.
 * - `GET /onboarding/channels` and `POST /onboarding/channels/marks`: marks
 *   and facts (a channel created, memory saved in `#general`, a DM).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  projectMembers,
  projectSessions,
  projectSpaces,
  projectUserMarks,
  projects,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { runFeatureFlagToggleEffects, toggleEffectsSettled } from '../feature-flags/toggle-effects';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OFF_PROJECT = crypto.randomUUID();
const FIRST_PROJECT = crypto.randomUUID();
/** An account member with no access to PROJECT. */
const OUTSIDER = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
/** Joins the account after the turn-on again: no intro mark yet. */
const SAM = crypto.randomUUID();
const OFF_WHILE = crypto.randomUUID();
const RETRY_A = crypto.randomUUID();
const RETRY_B = crypto.randomUUID();
const FAIL_ONCE = crypto.randomUUID();
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

const ON = { experimental: { project_channels: true } };
const OFF = { experimental: { project_channels: false } };

/**
 * PATCH the flag, then run the toggle effect once more and await it, with the
 * context the write produced (`writtenAt` = the row's `updated_at`). The copy
 * the route started behind its response converges to the same state; the test
 * awaits it too (`toggleEffectsSettled`), so nothing writes after an assertion.
 */
async function toggle(projectId: string, enabled: boolean, between?: () => Promise<unknown>) {
  const res = await req('PATCH', `/v1/projects/${projectId}/features`, keys[`manager:${projectId}`]!, { feature: 'project_channels', enabled });
  expect(res.status).toBe(200);
  await between?.();
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId));
  const ctx = { key: 'project_channels' as const, projectId, accountId: ACCOUNT, metadata: row!.metadata, previousMetadata: enabled ? OFF : ON, writtenAt: row!.updatedAt };
  await runFeatureFlagToggleEffects(ctx);
  await toggleEffectsSettled();
  return ctx;
}

const introMarks = async (projectId: string) =>
  (await db.select({ userId: projectUserMarks.userId }).from(projectUserMarks).where(and(eq(projectUserMarks.projectId, projectId), eq(projectUserMarks.mark, 'channels_intro')))).map((r) => r.userId).sort();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'channels-onboarding' });
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'Northwind', repoUrl: 'https://example.test/n.git', metadata: { experimental: { project_channels: true } } },
    { projectId: OFF_PROJECT, accountId: ACCOUNT, name: 'Acme', repoUrl: 'https://example.test/a.git' },
    { projectId: FIRST_PROJECT, accountId: ACCOUNT, name: 'Globex', repoUrl: 'https://example.test/g.git' },
  ]);
  await insertIntoView(db, accountMembers, [
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: PRIYA, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: OUTSIDER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: FIRST_PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: FIRST_PROJECT, userId: PRIYA, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: PRIYA, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: OFF_PROJECT, userId: PRIYA, projectRole: 'member' },
  ]);
  keys.manager = await mint(MANAGER);
  keys[`manager:${PROJECT}`] = keys.manager;
  keys[`manager:${FIRST_PROJECT}`] = await mint(MANAGER, FIRST_PROJECT);
  keys.priyaFirst = await mint(PRIYA, FIRST_PROJECT);
  keys.priya = await mint(PRIYA);
  keys.priyaOff = await mint(PRIYA, OFF_PROJECT);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projectSessions).where(eq(projectSessions.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('only a project admin turns Channels on or off', () => {
  test('a member gets 403 naming project.settings.write, and the flag stays on', async () => {
    const res = await req('PATCH', `${base}/features`, keys.priya, { feature: 'project_channels', enabled: false });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('(project.settings.write)');
    const [row] = await db.select({ m: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
    expect((row!.m as any).experimental.project_channels).toBe(true);
  });
});

describe('the first turn-on', () => {
  test('a #general made by a channel list before the effect runs is still a first turn-on: intros stay unseen', async () => {
    await toggle(FIRST_PROJECT, true, async () => {
      // The window between the flag write and the effect: the admin's own UI lists channels.
      expect((await req('GET', `/v1/projects/${FIRST_PROJECT}/spaces`, keys.priyaFirst)).status).toBe(200);
    });
    const [row] = await db.select({ m: projects.metadata }).from(projects).where(eq(projects.projectId, FIRST_PROJECT));
    expect((row!.m as any).channels).toBeUndefined();
    expect(await introMarks(FIRST_PROJECT)).toEqual([]);
    const body = (await (await req('GET', `/v1/projects/${FIRST_PROJECT}/onboarding/channels`, keys.priyaFirst)).json()) as any;
    expect(body.intro_seen).toBe(false);
  });
});

describe('turning Channels on again', () => {
  test('the session started while off moves into #general, with the notice and no intro for project members', async () => {
    // First on: `#general` exists (made on the first channel list).
    const first = await req('GET', `${base}/spaces`, keys.priya);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody.general_notice).toBeUndefined();
    const general = firstBody.spaces.find((space: any) => space.is_default);

    await toggle(PROJECT, false);
    await db.insert(projectSessions).values({ sessionId: OFF_WHILE, accountId: ACCOUNT, projectId: PROJECT, branchName: 'o', createdBy: PRIYA, agentName: 'kortix' });
    await toggle(PROJECT, true);

    const channels = await channelsMeta();
    expect(channels.reenabled_count).toBe(1);
    const [session] = await db.select({ spaceId: projectSessions.spaceId }).from(projectSessions).where(eq(projectSessions.sessionId, OFF_WHILE));
    expect(session!.spaceId).toBe(general.space_id);

    const list = (await (await req('GET', `${base}/spaces`, keys.priya)).json()) as any;
    expect(list.general_notice).toEqual({ kind: 'reenabled', at: channels.reenabled_at, count: 1 });
    const onboarding = (await (await req('GET', `${base}/onboarding/channels`, keys.priya)).json()) as any;
    expect(onboarding.intro_seen).toBe(true);
    // Project members only: the account member without access to the project gets no mark.
    expect(await introMarks(PROJECT)).toEqual([MANAGER, PRIYA].sort());
  });

  test('a retry of the effect keeps the count it already recorded', async () => {
    await toggle(PROJECT, false);
    await db.insert(projectSessions).values([
      { sessionId: RETRY_A, accountId: ACCOUNT, projectId: PROJECT, branchName: 'a', createdBy: PRIYA, agentName: 'kortix' },
      { sessionId: RETRY_B, accountId: ACCOUNT, projectId: PROJECT, branchName: 'b', createdBy: PRIYA, agentName: 'kortix' },
    ]);
    const ctx = await toggle(PROJECT, true);
    await runFeatureFlagToggleEffects(ctx);
    const channels = await channelsMeta();
    expect(channels).toEqual({ reenabled_at: ctx.writtenAt.toISOString(), reenabled_count: 2 });
  });

  test('the marks insert fails once: the retry keeps the recorded count and writes the marks', async () => {
    await toggle(PROJECT, false);
    await db.insert(projectSessions).values({ sessionId: FAIL_ONCE, accountId: ACCOUNT, projectId: PROJECT, branchName: 'f', createdBy: PRIYA, agentName: 'kortix' });
    await db.delete(projectUserMarks).where(eq(projectUserMarks.projectId, PROJECT));
    // Turn on without the route, so this effect is the only one: the flag write as `writeProjectFeatureFlag` does it.
    const [row] = await db
      .update(projects)
      .set({ metadata: { experimental: { project_channels: true } }, updatedAt: sql`date_trunc('milliseconds', now())` })
      .where(eq(projects.projectId, PROJECT))
      .returning();
    // The first marks INSERT for this project fails once (a sequence survives the rollback).
    const name = `kortix.onb_fail_${PROJECT.replaceAll('-', '')}`;
    await db.execute(sql.raw(`create sequence ${name}`));
    await db.execute(
      sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
        if new.project_id = '${PROJECT}' and nextval('${name}') = 1 then raise exception 'synthetic marks failure'; end if;
        return new; end $$`),
    );
    await db.execute(sql.raw(`create trigger onb_fail before insert on kortix.project_user_marks for each row execute function ${name}()`));
    try {
      await runFeatureFlagToggleEffects({ key: 'project_channels', projectId: PROJECT, accountId: ACCOUNT, metadata: row!.metadata, previousMetadata: OFF, writtenAt: row!.updatedAt });
    } finally {
      await db.execute(sql.raw(`drop trigger onb_fail on kortix.project_user_marks; drop function ${name}(); drop sequence ${name}`));
    }
    expect(await channelsMeta()).toEqual({ reenabled_at: row!.updatedAt.toISOString(), reenabled_count: 1 });
    expect(await introMarks(PROJECT)).toEqual([MANAGER, PRIYA].sort());
  });

  test('a repeated "on" (on before the write too) records nothing new', async () => {
    const before = await channelsMeta();
    await runFeatureFlagToggleEffects({ key: 'project_channels', projectId: PROJECT, accountId: ACCOUNT, metadata: ON, previousMetadata: ON, writtenAt: new Date() });
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

    // A note or page saved in `#general`'s memory (a Drive write the memory routes make) records this mark;
    // this suite has no Drive storage, so it records the mark the route writes.
    await db.insert(projectUserMarks).values({ projectId: PROJECT, userId: SAM, mark: 'get_started.remember' });
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
