/**
 * Integration test (real local PostgreSQL): a Slack write from one project
 * stays out of another project's channels and threads, and a thread bind
 * lands only in a workspace the project's install proved. A Telegram write
 * from a session a chat started, or a chat is bound to, stays in that chat.
 * Real: chat_installs, chat_channel_bindings, chat_threads, project_sessions,
 * project_secrets rows and their SQL. Faked: Slack and Telegram (the gateway's
 * fetch).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, chatChannelBindings, chatInstalls, chatThreads, projectSecrets, projectSessions } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { CONVERSATION_NOT_IN_PROJECT } from '../connectors/channel-read-scope';
import { gateChannelWrite, slackWriteRefusal } from '../connectors/channel-write-scope';
import { type GatewayDeps, handleCall } from '../connectors/gateway';
import { findChatThread } from '../channels/core/threads';
import { SLACK_TEAM_ID, deleteSlackInstall, loadSlackTeamIdForProject, saveSlackInstall } from '../channels/install-store';
import { bindSlackThreadToSession } from '../channels/slack/binding';
import { encryptProjectSecret } from '../projects/secrets/envelope';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

// The routes run through the real app; the account token is the caller.
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');

const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
const WS = `T0SHARED${RUN}`;
const FOREIGN_WS = `T0FOREIGN${RUN}`;
const C_MINE = `C0MINE${RUN}`;
const C_OTHER = `C0OTHER${RUN}`;
const C_NOBODY = `C0NOBODY${RUN}`;
const D_OTHER = `D0OTHERDM${RUN}`;
const T_OTHER = '1700000100.000100';
const T_MINE = '1700000200.000200';

let mine: SeededProject;
let other: SeededProject;
let bare: SeededProject;
let mineSession: string;
let ownerToken: string;
let bareToken: string;
const tokenIds: string[] = [];
const OWNER = crypto.randomUUID();

beforeAll(async () => {
  mine = await seedProject('channel-write-mine');
  other = await seedProject('channel-write-other');
  bare = await seedProject('channel-write-bare', { accountId: mine.account_id });
  mineSession = await seedSession(mine, crypto.randomUUID());
  const otherSession = await seedSession(other, crypto.randomUUID());
  // Both installs through the install path, so the workspace is proven in
  // chat_installs and SLACK_TEAM_ID is written as a connector secret.
  for (const project of [mine, other]) {
    await saveSlackInstall({
      projectId: project.project_id,
      teamId: WS,
      teamName: 'synthetic',
      botToken: 'xoxb-synthetic',
      signingSecret: 'synthetic',
      botUserId: 'U0BOTUSER1',
    });
  }
  await db.insert(chatChannelBindings).values([
    { platform: 'slack', workspaceId: WS, channelId: C_MINE, projectId: mine.project_id },
    { platform: 'slack', workspaceId: WS, channelId: C_OTHER, projectId: other.project_id },
    // A person's DM with the bot, bound to the other project.
    { platform: 'slack', workspaceId: WS, channelId: D_OTHER, projectId: other.project_id },
  ]);
  await db.insert(chatThreads).values([
    { platform: 'slack', workspaceId: WS, threadId: T_OTHER, projectId: other.project_id, sessionId: otherSession },
    { platform: 'slack', workspaceId: WS, threadId: T_MINE, projectId: mine.project_id, sessionId: mineSession },
  ]);
  // An account owner counts as a manager of the project (connector.write).
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: mine.account_id, accountRole: 'owner' });
  const token = await createAccountToken({
    accountId: mine.account_id,
    userId: OWNER,
    projectId: mine.project_id,
    name: 'channel-write-scope-test',
  });
  const bareOwner = await createAccountToken({
    accountId: mine.account_id,
    userId: OWNER,
    projectId: bare.project_id,
    name: 'channel-write-scope-test-bare',
  });
  ownerToken = token.secretKey;
  bareToken = bareOwner.secretKey;
  tokenIds.push(token.tokenId, bareOwner.tokenId);
});

afterAll(async () => {
  for (const tokenId of tokenIds) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(chatThreads).where(inArray(chatThreads.workspaceId, [WS, FOREIGN_WS]));
  await db.delete(chatChannelBindings).where(eq(chatChannelBindings.workspaceId, WS));
  for (const project of [mine, other]) await deleteSlackInstall(project.project_id);
  await db.delete(chatInstalls).where(inArray(chatInstalls.workspaceId, [WS, FOREIGN_WS]));
  await db.delete(projectSessions).where(inArray(projectSessions.projectId, [mine.project_id, other.project_id]));
  await removeSeeded([mine, other, bare]);
});

const kind = async (target: Parameters<typeof slackWriteRefusal>[1], projectId = mine.project_id) =>
  (await slackWriteRefusal(projectId, target))?.kind ?? null;

describe('Slack writes against real ownership rows', () => {
  test("another project's channel is refused; this project's, an unowned one and a DM are not", async () => {
    expect(await kind({ channel: C_OTHER })).toBe('channel');
    expect(await kind({ channel: C_MINE })).toBeNull();
    expect(await kind({ channel: C_NOBODY })).toBeNull();
    expect(await kind({ channel: D_OTHER })).toBeNull();
    expect(await kind({ channel: 'U0SOMEONE1' })).toBeNull();
    // The other project is bound by the same rule.
    expect(await kind({ channel: C_MINE }, other.project_id)).toBe('channel');
  });

  test("a thread decides before its channel: another project's is refused anywhere, this project's is allowed anywhere", async () => {
    expect(await kind({ channel: D_OTHER, ts: T_OTHER })).toBe('thread');
    expect(await kind({ channel: C_MINE, ts: T_OTHER })).toBe('thread');
    expect(await kind({ channel: C_OTHER, ts: T_MINE })).toBeNull();
    // A message no session owns follows its conversation.
    expect(await kind({ channel: C_OTHER, ts: '1700000300.000300' })).toBe('channel');
    expect(await kind({ channel: D_OTHER, ts: '1700000300.000300' })).toBeNull();
  });

  test('a project with no install on record writes nothing', async () => {
    expect(await kind({ channel: C_NOBODY }, bare.project_id)).toBe('install');
  });

  test('the connector refuses before Slack; an allowed post reaches Slack', async () => {
    const run = async (args: Record<string, unknown>) => {
      const fetched: string[] = [];
      const deps: GatewayDeps = {
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
          path: 'kortix_slack.send_message',
          relPath: 'send_message',
          inputSchema: { type: 'object', properties: { channel: {}, text: {}, thread_ts: {} } },
          risk: 'write',
          binding: { kind: 'http', method: 'POST', path: '/chat.postMessage' },
        }),
        resolveCredential: async () => 'xoxb-synthetic',
        loadPolicies: async () => [],
        recordExecution: async () => null,
        gateChannelWrite: (input) => gateChannelWrite(input),
        // Slack answers a post with the conversation it posted to.
        fetchImpl: async (url, init) => {
          fetched.push(url);
          const posted = JSON.parse(init.body ?? '{}') as { channel?: string };
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ ok: true, channel: posted.channel, ts: '1700000400.000400' }),
          };
        },
      };
      const res = await handleCall(deps, {
        projectId: mine.project_id,
        accountId: mine.account_id,
        subject: { userId: crypto.randomUUID(), groupIds: [] },
        connectorSlug: 'kortix_slack',
        actionPath: 'send_message',
        args,
      });
      return { res, fetched };
    };
    const refused = await run({ channel: C_OTHER, text: 'hi' });
    expect(refused.res).toMatchObject({ status: 'denied', reason: CONVERSATION_NOT_IN_PROJECT });
    expect(refused.fetched).toEqual([]);
    const allowed = await run({ channel: D_OTHER, text: 'build is green' });
    expect(allowed.res.status).toBe('ok');
    expect(allowed.fetched).toEqual(['https://slack.com/api/chat.postMessage']);
  });
});

describe('thread binds land only in a proven workspace', () => {
  test('a workspace the install did not prove is refused, and no thread row is written there', async () => {
    const binding = await bindSlackThreadToSession({
      projectId: mine.project_id,
      sessionId: mineSession,
      channel: 'D0SOMEONE01',
      threadTs: '1700000500.000500',
      workspaceId: FOREIGN_WS,
    });
    expect(binding).toEqual({ bound: false, thread_ts: '1700000500.000500', reason: 'workspace_unknown' });
    expect(await findChatThread({ platform: 'slack', workspaceId: FOREIGN_WS, threadId: '1700000500.000500' })).toBeNull();
  });

  test('an overwritten SLACK_TEAM_ID secret does not move the bind: the proven workspace does', async () => {
    // The generic secrets API lets a project manager write this name.
    await db
      .update(projectSecrets)
      .set({ valueEnc: encryptProjectSecret(mine.project_id, FOREIGN_WS) })
      .where(and(eq(projectSecrets.projectId, mine.project_id), eq(projectSecrets.name, SLACK_TEAM_ID)));
    expect(await loadSlackTeamIdForProject(mine.project_id)).toBe(FOREIGN_WS);

    const binding = await bindSlackThreadToSession({
      projectId: mine.project_id,
      sessionId: mineSession,
      channel: 'D0SOMEONE01',
      threadTs: '1700000600.000600',
    });
    expect(binding).toEqual({ bound: true, thread_ts: '1700000600.000600', session_id: mineSession });
    expect(await findChatThread({ platform: 'slack', workspaceId: WS, threadId: '1700000600.000600' })).toEqual({
      sessionId: mineSession,
      projectId: mine.project_id,
    });
    expect(await findChatThread({ platform: 'slack', workspaceId: FOREIGN_WS, threadId: '1700000600.000600' })).toBeNull();
  });
});

describe('the file upload and bind-thread routes', () => {
  const post = (path: string, body: unknown, project = mine, token = ownerToken) =>
    app.request(`/v1/projects/${project.project_id}/channels/slack/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const file = { filename: 'report.txt', content_base64: Buffer.from('synthetic').toString('base64') };

  test("a file into another project's channel or thread is refused before Slack; a malformed channel is a 400, no install a 404", async () => {
    const intoChannel = await post('file/upload', { ...file, channel: C_OTHER });
    expect(intoChannel.status).toBe(403);
    expect(await intoChannel.json()).toMatchObject({ reason: CONVERSATION_NOT_IN_PROJECT });
    const intoThread = await post('file/upload', { ...file, channel: D_OTHER, thread_ts: T_OTHER });
    expect(intoThread.status).toBe(403);
    expect(String((await intoThread.json()).error)).toContain(`Slack thread ${T_OTHER}`);
    expect((await post('file/upload', { ...file, channel: 'general' })).status).toBe(400);
    // No Slack install: the route's answer before this rule, not connected.
    const unconnected = await post('file/upload', { ...file, channel: C_NOBODY }, bare, bareToken);
    expect(unconnected.status).toBe(404);
    expect(String((await unconnected.json()).error)).toContain('no Slack install on record');
  });

  test('bind-thread: a foreign workspace is a 400, a thread in another project\'s channel a 403', async () => {
    const foreign = await post('bind-thread', {
      session_id: mineSession,
      channel: D_OTHER,
      thread_ts: '1700000700.000700',
      workspace_id: FOREIGN_WS,
    });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ code: 'SLACK_WORKSPACE_NOT_CONNECTED' });

    const inOtherChannel = await post('bind-thread', { session_id: mineSession, channel: C_OTHER, thread_ts: '1700000800.000800' });
    expect(inOtherChannel.status).toBe(403);
    expect(await inOtherChannel.json()).toMatchObject({ code: 'CONVERSATION_NOT_IN_PROJECT', reason: CONVERSATION_NOT_IN_PROJECT });
    expect(await findChatThread({ platform: 'slack', workspaceId: WS, threadId: '1700000800.000800' })).toBeNull();
  });

  test("bind-thread: another project's thread keeps its answer; a DM thread binds", async () => {
    const owned = await post('bind-thread', { session_id: mineSession, channel: C_MINE, thread_ts: T_OTHER });
    expect(owned.status).toBe(403);
    expect(await owned.json()).toMatchObject({ code: 'THREAD_OWNED_BY_ANOTHER_PROJECT' });

    const dm = await post('bind-thread', { session_id: mineSession, channel: D_OTHER, thread_ts: '1700000900.000900' });
    expect(dm.status).toBe(200);
    expect(await dm.json()).toMatchObject({ ok: true, bound: true, session_id: mineSession });
  });
});

describe('Telegram writes stay in the chat that started or is bound to the session', () => {
  const BOT = `7${RUN.replace(/\D/g, '').padEnd(6, '0').slice(0, 6)}`;
  const OWN_CHAT = 111222333;
  const GROUP = -100777888;
  const OTHER_CHAT = 444555666;
  let chatSession: string;
  let boundSession: string;
  let webSession: string;

  beforeAll(async () => {
    chatSession = await seedSession(mine, crypto.randomUUID());
    boundSession = await seedSession(mine, crypto.randomUUID());
    webSession = await seedSession(mine, crypto.randomUUID());
    // The metadata the Telegram inbound path writes on a session a chat starts.
    await db
      .update(projectSessions)
      .set({ metadata: { source: 'telegram', telegram: { bot_id: BOT, chat_id: OWN_CHAT, chat_type: 'private' } } })
      .where(eq(projectSessions.sessionId, chatSession));
    // A reminder's successor session: a trigger started it, and it adopted a
    // forum topic of a group (`adoptChatThreads`).
    await db.update(projectSessions).set({ metadata: { source: 'trigger' } }).where(eq(projectSessions.sessionId, boundSession));
    await db.insert(chatThreads).values({
      platform: 'telegram',
      workspaceId: BOT,
      threadId: `${GROUP}:42`,
      projectId: mine.project_id,
      sessionId: boundSession,
    });
  });

  afterAll(async () => {
    await db.delete(chatThreads).where(eq(chatThreads.workspaceId, BOT));
  });

  const gate = async (sessionId: string | null, actionPath: string, args: Record<string, unknown>) =>
    (await gateChannelWrite({ projectId: mine.project_id, platform: 'telegram', sessionId, actionPath, args }))
      .refusal;

  test("a chat's session sends, edits and deletes in its own chat and any topic of it; every other chat is refused", async () => {
    expect(await gate(chatSession, 'send_message', { chat_id: OWN_CHAT, text: 'done' })).toBeNull();
    expect(await gate(chatSession, 'send_message', { chat_id: String(OWN_CHAT), message_thread_id: 7, text: 'done' })).toBeNull();
    expect(await gate(chatSession, 'edit_message_text', { chat_id: OWN_CHAT, message_id: 5, text: 'done' })).toBeNull();
    expect(await gate(chatSession, 'delete_message', { chat_id: OWN_CHAT, message_id: 5 })).toBeNull();
    for (const [action, args] of [
      ['send_message', { chat_id: OTHER_CHAT, text: 'hi' }],
      ['edit_message_text', { chat_id: OTHER_CHAT, message_id: 5, text: 'hi' }],
      ['delete_message', { chat_id: OTHER_CHAT, message_id: 5 }],
      ['send_chat_action', { chat_id: OTHER_CHAT, action: 'typing' }],
      ['send_message', { chat_id: '@other_channel', text: 'hi' }],
      ['send_message', { chat_id: 'not-a-chat', text: 'hi' }],
      ['send_message', { text: 'hi' }],
    ] as const) {
      expect(await gate(chatSession, action, args)).toEqual({
        reason: CONVERSATION_NOT_IN_PROJECT,
        message: `This session answers Telegram chat ${OWN_CHAT} only. It does not send to, edit or delete messages in other chats.`,
      });
    }
  });

  test('a session a chat is bound to writes to that chat (the binding names a topic) and to no other', async () => {
    expect(await gate(boundSession, 'send_message', { chat_id: GROUP, text: 'reminder' })).toBeNull();
    expect(await gate(boundSession, 'send_message', { chat_id: GROUP, message_thread_id: 42, text: 'reminder' })).toBeNull();
    expect((await gate(boundSession, 'send_message', { chat_id: OWN_CHAT, text: 'reminder' }))?.message).toBe(
      `This session answers Telegram chat ${GROUP} only. It does not send to, edit or delete messages in other chats.`,
    );
  });

  test('a web session, an automation without a session, and every read reach any chat', async () => {
    expect(await gate(webSession, 'send_message', { chat_id: OTHER_CHAT, text: 'order shipped' })).toBeNull();
    expect(await gate(webSession, 'delete_message', { chat_id: OTHER_CHAT, message_id: 5 })).toBeNull();
    expect(await gate(null, 'send_message', { chat_id: OTHER_CHAT, text: 'order shipped' })).toBeNull();
    expect(await gate(chatSession, 'get_chat', { chat_id: OTHER_CHAT })).toBeNull();
    expect(await gate(chatSession, 'get_me', {})).toBeNull();
  });

  test("a chat's session replies only to messages of its own chats (`reply_parameters`), given as an object", async () => {
    const reply = (replyParameters: unknown) =>
      gate(chatSession, 'send_message', { chat_id: OWN_CHAT, text: 'done', reply_parameters: replyParameters });
    expect(await reply({ message_id: 5 })).toBeNull();
    expect(await reply({ chat_id: OWN_CHAT, message_id: 5 })).toBeNull();
    expect(await reply({ chat_id: String(OWN_CHAT), message_id: 5 })).toBeNull();
    for (const quoted of [{ chat_id: OTHER_CHAT, message_id: 5 }, { chat_id: '@other_channel', message_id: 5 }]) {
      expect(await reply(quoted)).toEqual({
        reason: CONVERSATION_NOT_IN_PROJECT,
        message: `This session answers Telegram chat ${OWN_CHAT} only. It does not send to, edit or delete messages in other chats.`,
      });
    }
    for (const encoded of [JSON.stringify({ chat_id: OTHER_CHAT, message_id: 5 }), null, [5]]) {
      expect(await reply(encoded)).toEqual({
        reason: CONVERSATION_NOT_IN_PROJECT,
        message: '`reply_parameters` must be an object, for example {"message_id": 5}.',
      });
    }
    // A session no chat started quotes any chat.
    expect(
      await gate(webSession, 'send_message', { chat_id: OTHER_CHAT, text: 'a', reply_parameters: { chat_id: OWN_CHAT, message_id: 5 } }),
    ).toBeNull();
  });

  describe('the confinement follows the lineage (`spawned_by_session`, `reminder_successor_of`)', () => {
    const withMetadata = async (metadata: Record<string, unknown>) => {
      const id = await seedSession(mine, crypto.randomUUID());
      await db.update(projectSessions).set({ metadata }).where(eq(projectSessions.sessionId, id));
      return id;
    };
    const OTHER_CHAT_REFUSAL = {
      reason: CONVERSATION_NOT_IN_PROJECT,
      message: `This session answers Telegram chat ${OWN_CHAT} only. It does not send to, edit or delete messages in other chats.`,
    } as const;

    test("a session a chat's session started writes to the parent's chat and to no other; so does its own child", async () => {
      const child = await withMetadata({ source: 'agent', spawned_by_session: chatSession });
      const grandchild = await withMetadata({ source: 'agent', spawned_by_session: child });
      for (const id of [child, grandchild]) {
        expect(await gate(id, 'send_message', { chat_id: OWN_CHAT, text: 'done' })).toBeNull();
        expect(await gate(id, 'send_message', { chat_id: OTHER_CHAT, text: 'from a worker session' })).toEqual(OTHER_CHAT_REFUSAL);
        expect(await gate(id, 'delete_message', { chat_id: OTHER_CHAT, message_id: 5 })).toEqual(OTHER_CHAT_REFUSAL);
      }
    });

    test("a reminder's successor whose thread row is gone stays in its predecessor's chat", async () => {
      const successor = await withMetadata({ source: 'trigger:reminder', reminder_successor_of: chatSession });
      expect(await gate(successor, 'send_message', { chat_id: OWN_CHAT, text: 'reminder' })).toBeNull();
      expect(await gate(successor, 'send_message', { chat_id: OTHER_CHAT, text: 'reminder' })).toEqual(OTHER_CHAT_REFUSAL);
    });

    test("the chats of every session in the lineage add up: a bound child of a chat's session writes to both", async () => {
      const child = await withMetadata({ source: 'agent', spawned_by_session: chatSession });
      await db.insert(chatThreads).values({ platform: 'telegram', workspaceId: BOT, threadId: `${GROUP}:43`, projectId: mine.project_id, sessionId: child });
      expect(await gate(child, 'send_message', { chat_id: GROUP, text: 'a' })).toBeNull();
      expect(await gate(child, 'send_message', { chat_id: OWN_CHAT, text: 'a' })).toBeNull();
      expect((await gate(child, 'send_message', { chat_id: OTHER_CHAT, text: 'a' }))?.message).toBe(
        `This session answers Telegram chat ${GROUP} or ${OWN_CHAT} only. It does not send to, edit or delete messages in other chats.`,
      );
    });

    test("a web session's child, and a lineage that loops, write to any chat", async () => {
      const child = await withMetadata({ source: 'agent', spawned_by_session: webSession });
      expect(await gate(child, 'send_message', { chat_id: OTHER_CHAT, text: 'order shipped' })).toBeNull();
      const a = await withMetadata({ source: 'agent' });
      const b = await withMetadata({ source: 'agent', spawned_by_session: a });
      await db.update(projectSessions).set({ metadata: { source: 'agent', spawned_by_session: b } }).where(eq(projectSessions.sessionId, a));
      expect(await gate(b, 'send_message', { chat_id: OTHER_CHAT, text: 'order shipped' })).toBeNull();
    });

    test('a lineage deeper than 8 sessions, or one whose parent row is gone, writes to no chat', async () => {
      const NO_CHAT = {
        reason: CONVERSATION_NOT_IN_PROJECT,
        message: "This session's Telegram chat is not on record, so it writes to no chat. It does not send to, edit or delete messages in other chats.",
      } as const;
      let tip = webSession;
      for (let depth = 0; depth < 9; depth++) tip = await withMetadata({ source: 'agent', spawned_by_session: tip });
      expect(await gate(tip, 'send_message', { chat_id: OTHER_CHAT, text: 'a' })).toEqual(NO_CHAT);
      const orphan = await withMetadata({ source: 'agent', spawned_by_session: crypto.randomUUID() });
      expect(await gate(orphan, 'send_message', { chat_id: OTHER_CHAT, text: 'a' })).toEqual(NO_CHAT);
    });
  });

  test('the connector refuses another chat before Telegram, and sends into its own chat', async () => {
    const run = async (sessionId: string, args: Record<string, unknown>) => {
      const fetched: string[] = [];
      const deps: GatewayDeps = {
        loadConnectorBySlug: async () => ({
          connectorId: 'conn-telegram',
          slug: 'kortix_telegram',
          provider: 'channel',
          platform: 'telegram',
          baseUrl: 'https://api.telegram.org',
          auth: { type: 'custom', in: 'path', name: null, prefix: 'bot' },
          hasAuth: true,
          credentialMode: 'shared',
          enabled: true,
        }),
        loadAction: async () => ({
          path: 'kortix_telegram.send_message',
          relPath: 'send_message',
          inputSchema: { type: 'object', properties: { chat_id: {}, text: {} } },
          risk: 'write',
          binding: { kind: 'http', method: 'POST', path: '/sendMessage' },
        }),
        resolveCredential: async () => '123456:synthetic',
        loadPolicies: async () => [],
        recordExecution: async () => null,
        gateChannelWrite: (input) => gateChannelWrite(input),
        fetchImpl: async (url) => {
          fetched.push(url);
          return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, result: { message_id: 9 } }) };
        },
      };
      const res = await handleCall(deps, {
        projectId: mine.project_id,
        accountId: mine.account_id,
        subject: { userId: crypto.randomUUID(), groupIds: [] },
        sessionId,
        connectorSlug: 'kortix_telegram',
        actionPath: 'send_message',
        args,
      });
      return { res, fetched };
    };
    const refused = await run(chatSession, { chat_id: OTHER_CHAT, text: 'hi' });
    expect(refused.res).toMatchObject({ status: 'denied', reason: CONVERSATION_NOT_IN_PROJECT });
    expect(refused.fetched).toEqual([]);
    const own = await run(chatSession, { chat_id: OWN_CHAT, text: 'done' });
    expect(own.res.status).toBe('ok');
    expect(own.fetched).toEqual(['https://api.telegram.org/bot123456:synthetic/sendMessage']);
  });
});
