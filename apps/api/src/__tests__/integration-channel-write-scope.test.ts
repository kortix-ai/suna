/**
 * Integration test (real local PostgreSQL): a Slack write from one project
 * stays out of another project's channels and threads, and a thread bind
 * lands only in a workspace the project's install proved. Real: chat_installs,
 * chat_channel_bindings, chat_threads, project_secrets rows and their SQL.
 * Faked: Slack (the gateway's fetch).
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
let ownerTokenId: string;
const OWNER = crypto.randomUUID();

beforeAll(async () => {
  mine = await seedProject('channel-write-mine');
  other = await seedProject('channel-write-other');
  bare = await seedProject('channel-write-bare');
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
  ownerToken = token.secretKey;
  ownerTokenId = token.tokenId;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where token_id = ${ownerTokenId}`);
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
  const post = (path: string, body: unknown) =>
    app.request(`/v1/projects/${mine.project_id}/channels/slack/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const file = { filename: 'report.txt', content_base64: Buffer.from('synthetic').toString('base64') };

  test("a file into another project's channel or thread is refused before Slack; a malformed channel is a 400", async () => {
    const intoChannel = await post('file/upload', { ...file, channel: C_OTHER });
    expect(intoChannel.status).toBe(403);
    expect(await intoChannel.json()).toMatchObject({ reason: CONVERSATION_NOT_IN_PROJECT });
    const intoThread = await post('file/upload', { ...file, channel: D_OTHER, thread_ts: T_OTHER });
    expect(intoThread.status).toBe(403);
    expect(String((await intoThread.json()).error)).toContain(`Slack thread ${T_OTHER}`);
    expect((await post('file/upload', { ...file, channel: 'general' })).status).toBe(400);
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
