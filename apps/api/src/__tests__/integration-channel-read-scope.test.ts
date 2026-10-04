/**
 * Integration test (real local PostgreSQL): a Slack or Teams connector read
 * reaches only the calling project's own conversations. Real: chat_installs,
 * chat_channel_bindings, chat_threads, project_sessions rows and the SQL in
 * `dbChannelOwnership`. Faked: the Slack/Graph answers (the gateway's fetch).
 *
 * Two projects share one Slack workspace and one Teams tenant, as they do
 * with the managed apps: both resolve the same platform token.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chatChannelBindings, chatInstalls, chatThreads, projectSessions } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import {
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelReadGate,
  gateChannelRead,
} from '../services/connectors/channel-read-scope';
import { type GatewayDeps, handleCall } from '../services/connectors/gateway';
import { db } from '../lib/db';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
const SHARED_WS = `T0SHARED${RUN}`;
const SOLO_WS = `T0SOLO${RUN}`;
const TENANT = `tenant-${RUN.toLowerCase()}`;

// Slack conversations in the shared workspace.
const C_MINE = `C0MINE${RUN}`;
const G_MINE = `G0MINE${RUN}`;
const C_OTHER = `C0OTHER${RUN}`;
const G_OTHER = `G0OTHER${RUN}`;
const C_PICKER = `C0PICKER${RUN}`;
const T_OTHER_IN_MINE = '1700000100.000100';
const T_MINE_IN_OTHER = '1700000200.000200';
// The solo workspace: one project connected, plus a channel a disconnected project still owns.
const C_SOLO_UNBOUND = `C0UNBOUND${RUN}`;
const C_GONE = `C0GONE${RUN}`;
// Teams channels in the shared tenant.
const CH = `19:chan-${RUN.toLowerCase()}@thread.tacv2`;
const CH_ONLY_OTHER = `19:onlyother-${RUN.toLowerCase()}@thread.tacv2`;
const CH_QUIET = `19:quiet-${RUN.toLowerCase()}@thread.tacv2`;
const CH_MIXED_STORED = `19:MiXeD-${RUN}@thread.tacv2`;
const CH_SESSION_ONLY = `19:sessiononly-${RUN.toLowerCase()}@thread.tacv2`;

let mine: SeededProject;
let other: SeededProject;
let gone: SeededProject;
let solo: SeededProject;

function gate(projectId: string, platform: 'slack' | 'teams', actionPath: string, args: Record<string, unknown>) {
  return gateChannelRead({ projectId, platform, actionPath, args, risk: 'read' });
}

function refused(g: ChannelReadGate): string {
  expect(g.refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  return g.refusal!.message;
}

async function answer(g: ChannelReadGate, data: unknown): Promise<unknown> {
  expect(g.refusal).toBeNull();
  const res = await g.answer(data);
  if ('refusal' in res) throw new Error(`answer refused: ${res.refusal.message}`);
  return res.data;
}

beforeAll(async () => {
  mine = await seedProject('channel-read-mine');
  other = await seedProject('channel-read-other');
  gone = await seedProject('channel-read-gone');
  solo = await seedProject('channel-read-solo');
  const mineSession = await seedSession(mine, crypto.randomUUID());
  const otherSession = await seedSession(other, crypto.randomUUID());

  await db.insert(chatInstalls).values([
    { platform: 'slack', workspaceId: SHARED_WS, projectId: mine.project_id },
    { platform: 'slack', workspaceId: SHARED_WS, projectId: other.project_id },
    { platform: 'slack', workspaceId: SOLO_WS, projectId: solo.project_id },
    { platform: 'teams', workspaceId: TENANT, projectId: mine.project_id },
    { platform: 'teams', workspaceId: TENANT, projectId: other.project_id },
  ]);
  await db.insert(chatChannelBindings).values([
    { platform: 'slack', workspaceId: SHARED_WS, channelId: C_MINE, projectId: mine.project_id },
    { platform: 'slack', workspaceId: SHARED_WS, channelId: G_MINE, projectId: mine.project_id },
    { platform: 'slack', workspaceId: SHARED_WS, channelId: C_OTHER, projectId: other.project_id },
    { platform: 'slack', workspaceId: SHARED_WS, channelId: G_OTHER, projectId: other.project_id },
    // A picker is waiting: the row exists, no project owns the channel yet.
    { platform: 'slack', workspaceId: SHARED_WS, channelId: C_PICKER, projectId: null },
    // Its project disconnected Slack; the binding stayed.
    { platform: 'slack', workspaceId: SOLO_WS, channelId: C_GONE, projectId: gone.project_id },
    { platform: 'teams', workspaceId: TENANT, channelId: `${CH};messageid=1`, projectId: mine.project_id },
    { platform: 'teams', workspaceId: TENANT, channelId: `${CH};messageid=2`, projectId: other.project_id },
    // Re-pointed to the other project while this project's session still runs it.
    { platform: 'teams', workspaceId: TENANT, channelId: `${CH};messageid=6`, projectId: other.project_id },
    { platform: 'teams', workspaceId: TENANT, channelId: `${CH_ONLY_OTHER};messageid=9`, projectId: other.project_id },
    { platform: 'teams', workspaceId: TENANT, channelId: `${CH_MIXED_STORED};messageid=5`, projectId: mine.project_id },
    { platform: 'teams', workspaceId: TENANT, channelId: `${CH_MIXED_STORED};messageid=7`, projectId: other.project_id },
  ]);
  await db.insert(chatThreads).values([
    // Another project's thread inside this project's channel (a channel re-pointed with `/kortix switch`).
    { platform: 'slack', workspaceId: SHARED_WS, threadId: T_OTHER_IN_MINE, projectId: other.project_id, sessionId: otherSession },
    // This project's session posted into the other project's channel.
    { platform: 'slack', workspaceId: SHARED_WS, threadId: T_MINE_IN_OTHER, projectId: mine.project_id, sessionId: mineSession },
    // A Teams thread whose session is the other project's and that has no binding.
    { platform: 'teams', workspaceId: TENANT, threadId: `${CH};messageid=3`, projectId: other.project_id, sessionId: otherSession },
    { platform: 'teams', workspaceId: TENANT, threadId: `${CH};messageid=6`, projectId: mine.project_id, sessionId: mineSession },
    // The only trace of the other project in this channel is its session.
    { platform: 'teams', workspaceId: TENANT, threadId: `${CH_SESSION_ONLY};messageid=8`, projectId: other.project_id, sessionId: otherSession },
  ]);
});

afterAll(async () => {
  const workspaces = [SHARED_WS, SOLO_WS, TENANT];
  await db.delete(chatThreads).where(inArray(chatThreads.workspaceId, workspaces));
  await db.delete(chatChannelBindings).where(inArray(chatChannelBindings.workspaceId, workspaces));
  await db.delete(chatInstalls).where(inArray(chatInstalls.workspaceId, workspaces));
  await db.delete(projectSessions).where(inArray(projectSessions.projectId, [mine.project_id, other.project_id]));
  await removeSeeded([mine, other, gone, solo]);
});

describe('Slack, a workspace two projects share', () => {
  test("each project reads its own channel and is refused the other's", async () => {
    expect((await gate(mine.project_id, 'slack', 'get_history', { channel: C_MINE })).refusal).toBeNull();
    expect(refused(await gate(mine.project_id, 'slack', 'get_history', { channel: C_OTHER }))).toContain(
      'belongs to another Kortix project',
    );
    expect((await gate(other.project_id, 'slack', 'get_history', { channel: C_OTHER })).refusal).toBeNull();
    expect(refused(await gate(other.project_id, 'slack', 'get_history', { channel: C_MINE.toLowerCase() }))).toContain(
      'belongs to another Kortix project',
    );
  });

  test('a channel no project owns, including one with a picker waiting, is refused', async () => {
    for (const channel of [C_PICKER, `C0NEVERSEEN${RUN}`]) {
      expect(refused(await gate(mine.project_id, 'slack', 'get_history', { channel }))).toContain(
        'connected to more than one Kortix project',
      );
    }
  });

  test("a thread's session decides over its channel, in both directions", async () => {
    expect((await gate(mine.project_id, 'slack', 'get_thread', { channel: C_OTHER, ts: T_MINE_IN_OTHER })).refusal).toBeNull();
    expect(refused(await gate(mine.project_id, 'slack', 'get_thread', { channel: C_MINE, ts: T_OTHER_IN_MINE }))).toContain(
      `Slack thread ${T_OTHER_IN_MINE}`,
    );
    expect(refused(await gate(other.project_id, 'slack', 'get_thread', { channel: C_OTHER, ts: T_MINE_IN_OTHER }))).toContain(
      'belongs to another Kortix project',
    );
    // No session owns this thread: the channel decides.
    expect((await gate(mine.project_id, 'slack', 'get_thread', { channel: C_MINE, ts: '1700000300.000300' })).refusal).toBeNull();
  });

  test("the channel's history comes back without the other project's thread", async () => {
    const data = await answer(await gate(mine.project_id, 'slack', 'get_history', { channel: C_MINE }), {
      ok: true,
      messages: [
        { ts: '1700000400.000400', text: 'ours' },
        { ts: T_OTHER_IN_MINE, thread_ts: T_OTHER_IN_MINE, text: 'their root' },
        { ts: '1700000150.000150', thread_ts: T_OTHER_IN_MINE, subtype: 'thread_broadcast', text: 'their broadcast' },
      ],
    });
    expect((data as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual(['ours']);
  });

  test("the channel list keeps public channels and this project's private ones", async () => {
    const data = await answer(await gate(mine.project_id, 'slack', 'list_channels', {}), {
      ok: true,
      channels: [
        { id: C_OTHER, is_private: false },
        { id: G_MINE, is_private: true },
        { id: G_OTHER, is_private: true },
        { id: C_PICKER, is_private: true },
      ],
    });
    expect((data as { channels: Array<{ id: string }> }).channels.map((c) => c.id)).toEqual([C_OTHER, G_MINE]);
  });

  test('search does not run in a shared workspace', async () => {
    expect(refused(await gate(mine.project_id, 'slack', 'search_messages', { query: 'budget' }))).toContain(
      'a search cannot be limited',
    );
  });
});

describe('Slack, a workspace one project has to itself', () => {
  test('a conversation no project owns is readable, and search runs', async () => {
    expect((await gate(solo.project_id, 'slack', 'get_history', { channel: C_SOLO_UNBOUND })).refusal).toBeNull();
    expect((await gate(solo.project_id, 'slack', 'search_messages', { query: 'budget' })).refusal).toBeNull();
  });

  test('a channel a disconnected project still owns stays refused', async () => {
    expect(refused(await gate(solo.project_id, 'slack', 'get_history', { channel: C_GONE }))).toContain(
      'belongs to another Kortix project',
    );
  });

  test('a project with no install on record reads nothing', async () => {
    expect(refused(await gate(gone.project_id, 'slack', 'get_history', { channel: C_GONE }))).toContain(
      'no Slack install on record',
    );
  });
});

describe('Teams, a tenant two projects share', () => {
  test("a channel this project has a conversation in is read without the other project's threads", async () => {
    const data = await answer(await gate(mine.project_id, 'teams', 'list_messages', { 'team-id': 'team', 'channel-id': CH }), {
      value: [
        { id: '1', body: { content: 'ours' } },
        { id: '2', body: { content: 'bound to theirs' } },
        { id: '3', body: { content: 'their session' } },
        { id: '4', body: { content: 'nobody asked the bot' } },
      ],
    });
    expect((data as { value: Array<{ id: string }> }).value.map((m) => m.id)).toEqual(['1', '4']);
  });

  test('a channel only the other project has a conversation in, or none has, is refused', async () => {
    expect(refused(await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': CH_ONLY_OTHER }))).toContain(
      'belongs to another Kortix project',
    );
    expect(refused(await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': CH_QUIET }))).toContain(
      'Mention the bot in that channel',
    );
    expect(refused(await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': CH_SESSION_ONLY }))).toContain(
      'belongs to another Kortix project',
    );
    expect((await gate(other.project_id, 'teams', 'list_messages', { 'channel-id': CH_ONLY_OTHER })).refusal).toBeNull();
  });

  test('a thread follows its session, then its binding, then its channel', async () => {
    const thread = (m: string) => ({ 'team-id': 'team', 'channel-id': CH, 'message-id': m });
    expect((await gate(mine.project_id, 'teams', 'get_message', thread('1'))).refusal).toBeNull();
    expect(refused(await gate(mine.project_id, 'teams', 'list_replies', thread('2')))).toContain('Teams thread 2');
    expect(refused(await gate(mine.project_id, 'teams', 'get_message', thread('3')))).toContain('Teams thread 3');
    expect((await gate(mine.project_id, 'teams', 'list_replies', thread('4'))).refusal).toBeNull();
    // Bound to the other project, but this project's session runs it.
    expect((await gate(mine.project_id, 'teams', 'get_message', thread('6'))).refusal).toBeNull();
    expect(refused(await gate(other.project_id, 'teams', 'get_message', thread('6')))).toContain('Teams thread 6');
  });

  test('channel ids compare without case', async () => {
    const lower = `19:mixed-${RUN.toLowerCase()}@thread.tacv2`;
    const upper = `19:MIXED-${RUN}@thread.tacv2`;
    expect((await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': lower })).refusal).toBeNull();
    expect(refused(await gate(other.project_id, 'teams', 'get_message', { 'channel-id': upper, 'message-id': '5' }))).toContain(
      'Teams thread 5',
    );
    // This project has a conversation in the channel, so only the thread's own owner can refuse it.
    expect(refused(await gate(mine.project_id, 'teams', 'get_message', { 'channel-id': lower, 'message-id': '7' }))).toContain(
      'Teams thread 7',
    );
  });
});

describe('the gateway with the database-backed gate', () => {
  function deps(body: string) {
    const fetched: string[] = [];
    const d: GatewayDeps = {
      loadConnectorBySlug: async () => ({
        connectorId: 'conn-slack',
        slug: 'kortix_slack',
        provider: 'channel',
        platform: 'slack',
        baseUrl: 'https://slack.com/api',
        auth: { type: 'bearer', in: 'header', name: null, prefix: null },
        hasAuth: true,
        credentialMode: 'shared',
        enabled: true,
      }),
      loadAction: async () => ({
        path: 'kortix_slack.get_history',
        relPath: 'get_history',
        inputSchema: { type: 'object', properties: { channel: {} } },
        risk: 'read',
        binding: { kind: 'http', method: 'GET', path: '/conversations.history' },
      }),
      resolveCredential: async () => 'xoxb-shared-workspace-token',
      loadPolicies: async () => [],
      recordExecution: async () => null,
      gateChannelRead: (input) => gateChannelRead(input),
      fetchImpl: async (url) => {
        fetched.push(url);
        return { status: 200, ok: true, text: async () => body };
      },
    };
    return { d, fetched };
  }
  const input = (channel: string) => ({
    projectId: mine.project_id,
    accountId: mine.account_id,
    subject: { userId: crypto.randomUUID(), groupIds: [] },
    connectorSlug: 'kortix_slack',
    actionPath: 'get_history',
    args: { channel },
  });

  test("the other project's channel never reaches Slack; this project's comes back filtered", async () => {
    const body = JSON.stringify({
      ok: true,
      messages: [
        { ts: '1700000400.000400', text: 'ours' },
        { ts: T_OTHER_IN_MINE, thread_ts: T_OTHER_IN_MINE, text: 'theirs' },
      ],
    });
    const denied = deps(body);
    expect(await handleCall(denied.d, input(C_OTHER))).toMatchObject({ status: 'denied', reason: CONVERSATION_NOT_IN_PROJECT });
    expect(denied.fetched).toEqual([]);

    const allowed = deps(body);
    expect(await handleCall(allowed.d, input(C_MINE))).toMatchObject({
      status: 'ok',
      data: { ok: true, messages: [{ ts: '1700000400.000400', text: 'ours' }] },
    });
    expect(allowed.fetched).toHaveLength(1);
  });
});
