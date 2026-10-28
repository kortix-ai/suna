/**
 * Real-Postgres contract for Telegram as a channel connector on the
 * conversation core: the inbox stores an update once, an unknown sender gets a
 * pairing reply and no session, an allowed sender in a new chat starts one
 * session bound to the chat, the next message follows up into it, `/new`
 * forgets it, and every outcome the agent cannot report reaches the chat.
 * Telegram is a local fake. The session lifecycle is a recorder that binds the
 * thread the way the real post-create step does, and the clock is an instant
 * sleep, so no sandbox and no real wait is needed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  accountTokens,
  accounts,
  chatEventDedup,
  chatThreads,
  connectorActions,
  connectorConnections,
  connectorPolicies,
  connectorPolicySets,
  connectorProjectPolicies,
  connectorProjectSettings,
  connectors,
  jobQueue,
  projectSessions,
  projects,
  sessionLifecycleCommands,
  sessionPendingQuestions,
  sessionSandboxes,
} from '@kortix/db';
import { and, eq, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteFromView, insertIntoView } from '../../__tests__/helpers/compat-views';
import { projectsApp } from '../../projects/surface';
import { registerTurnQuestionsRoutes } from '../../projects/routes/turn-questions';
import { questionReleaseSentinel } from '../question-release';
import { relayTurnQuestion } from '../turn-relay';
import { ensureDefaultConnection } from '../../connectors/credentials';
import { resolveTokenPrincipal } from '../../connectors/db-deps-principal';
import { createAccountToken } from '../../repositories/account-tokens';
import { config } from '../../config';
import { emitIntegrationEvent, INTEGRATION_EVENTS_QUEUE } from '../../integrations/event-inbox';
import { connectorConnectionIsConnected } from '../../projects/lib/session-connector-bindings';
import { db } from '../../shared/db';
import { config as appConfig } from '../../config';
import { forgetChatThread, resetChannelLifecycleForTest, setChannelLifecycleForTest } from '../core/conversation';
import { notifySessionChannel, notifyStartFailure } from '../core/session-notice';
import { notifySessionProvisioningFailed } from '../../shared/session-failure-notifier';
import { adoptChatThreads, bindChatThread, claimThreadCreate } from '../core/threads';
import { applyPostCreateActions, createCommandStatus, createSession } from '../../projects/session-lifecycle/create-session';
import { turnPromptSource } from '../../projects/lib/notification-recipients';
import { sessionWebUrl } from '../slack/util';
import { deleteTelegramInstall, recordTelegramAccessRequest, saveTelegramInstall, setTelegramAllowedUserIds } from './installs';
import { registerChannelTelegramRoutes } from '../../projects/routes/channel-telegram';
import { serializeProject } from '../../projects/lib/serializers';
import { handleTelegramEvent, handleTelegramPress, telegramMessageEvent, telegramPressEvent, type TelegramMessage } from './session';
import { telegramWebhookApp } from '../telegram-webhook';
import { runJobBatch } from '../../shared/job-queue';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ACTOR = crypto.randomUUID();
const BOT_ID = String(5_000_000_000 + Math.floor(Math.random() * 1_000_000));
const TOKEN = `${BOT_ID}:${'A'.repeat(35)}`;
const ALLOWED = '111';
let CONNECTOR = '';
let CONNECTION = '';

/** No sandbox runs here: the runtime's answer to a release is set per test (default: it cannot be reached). */
let releaseOutcome: 'released' | 'already_answered' | 'unreachable' = 'unreachable';
const releases: unknown[][] = [];
mock.module('../../projects/session-lifecycle/release-runtime-question', () => ({
  releaseRuntimeQuestion: async (...args: unknown[]) => {
    releases.push(args);
    return releaseOutcome;
  },
}));

type Call = { method: string; body: Record<string, unknown> };
const calls: Call[] = [];
const waiters: Array<(call: Call) => void> = [];
/** The next Bot API call, for a send nothing awaits (the provisioning notifier fires and forgets). */
const nextCall = () => new Promise<Call>((resolve) => waiters.push(resolve));
/** Runs inside a Bot API call, before it answers: a test changes state mid-press. */
let onCall: ((call: Call) => Promise<void>) | null = null;
/** This project's webhook, subscribed to both update types, as connect sets it. */
const ownWebhook = () => ({ url: `https://example.test/v1/webhooks/telegram/${PROJECT}`, allowed_updates: ['message', 'callback_query'] });
let webhookInfo: Record<string, unknown> = ownWebhook();
/** A Bot API method the fake fails with a 500. */
let failing: string | null = null;
/** getChat per user id: a profile, or 'fail' for a 500. Any other id: Telegram's "chat not found". */
const chats = new Map<string, Record<string, unknown> | 'fail'>();
/** Synthetic JPEG bytes the fake serves for every file. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
/** Paths of file downloads the fake served. */
const downloads: string[] = [];
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/file/')) {
      downloads.push(path);
      if (!path.startsWith(`/file/bot${TOKEN}/`)) return new Response('Not Found', { status: 404 });
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    }
    const [, botToken, method] = path.split('/');
    if (botToken !== `bot${TOKEN}`) return Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 });
    const call = { method: method ?? '', body: (await req.json().catch(() => ({}))) as Record<string, unknown> };
    calls.push(call);
    await onCall?.(call);
    waiters.splice(0).forEach((resolve) => resolve(call));
    if (call.method === failing) return Response.json({ ok: false, description: 'synthetic failure' }, { status: 500 });
    if (call.method === 'getChat') {
      const chat = chats.get(String(call.body.chat_id));
      if (chat === 'fail') return Response.json({ ok: false, description: 'synthetic failure' }, { status: 500 });
      if (!chat) return Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 });
      return Response.json({ ok: true, result: { id: Number(call.body.chat_id), type: 'private', ...chat } });
    }
    if (call.method === 'getFile') {
      return Response.json({ ok: true, result: { file_id: call.body.file_id, file_path: `photos/${call.body.file_id}.jpg` } });
    }
    return Response.json({ ok: true, result: call.method === 'getWebhookInfo' ? webhookInfo : { message_id: 1 } });
  },
});

const created: Array<Record<string, any>> = [];
const createdSessions: string[] = [];
const delivered: Array<Record<string, any>> = [];
/** Null: create the session and bind the thread, as the lifecycle's post-create step does. */
let createResult: Record<string, unknown> | null = null;
let createThrows = false;
let duringCreate: (() => Promise<unknown>) | null = null;
let deliverResult = 'queued';
let actor: string | null = ACTOR;
let onSleep: (() => Promise<unknown>) | null = null;
let sleeps = 0;
let updateId = 1;

function update(text: string, from = ALLOWED, chatId = 777) {
  const message: TelegramMessage = {
    message_id: updateId,
    date: 1_760_000_000,
    chat: { id: chatId, type: 'private' },
    from: { id: Number(from), username: 'synthetic' },
    text,
  };
  return telegramMessageEvent(PROJECT, BOT_ID, { update_id: updateId++, message })!;
}

const claimKey = (chat: number) => `telegram:threadcreate:${PROJECT}:${BOT_ID}:${chat}`;
const claimRows = (chat: number) => db.select().from(chatEventDedup).where(eq(chatEventDedup.eventId, claimKey(chat)));
const holdClaim = (chat: number, expiresInMs = 60_000) =>
  db.insert(chatEventDedup).values({ eventId: claimKey(chat), expiresAt: new Date(Date.now() + expiresInMs) });
const threadRow = async (chat: number) =>
  (await db.select().from(chatThreads).where(and(eq(chatThreads.workspaceId, BOT_ID), eq(chatThreads.threadId, String(chat)))))[0];
const replies = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
/** The lifecycle's `create_session` row for a message, as `createSession` writes it. */
const createCommand = (event: { id: string }, status: string, projectId = PROJECT) =>
  db.insert(sessionLifecycleCommands).values({
    commandType: 'create_session',
    source: 'telegram',
    status: status as never,
    projectId,
    accountId: ACCOUNT,
    idempotencyKey: `telegram:create:${BOT_ID}:${event.id}`,
  });

async function newSession() {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({ sessionId, accountId: ACCOUNT, projectId: PROJECT, branchName: sessionId, createdBy: ACTOR });
  return sessionId;
}

async function bindChat(chat: number) {
  const sessionId = await newSession();
  await bindChatThread({ projectId: PROJECT, platform: 'telegram', workspaceId: BOT_ID, threadId: String(chat), sessionId });
  return sessionId;
}

async function allowSender() {
  await db
    .update(projects)
    .set({ metadata: { telegram: { allowedUserIds: [ALLOWED] } } })
    .where(eq(projects.projectId, PROJECT));
}

beforeAll(async () => {
  (config as { TELEGRAM_API_URL: string }).TELEGRAM_API_URL = fake.url.origin;
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'telegram-v2-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'telegram-v2',
    // A repository that fails at once (a host name would wait on DNS): the
    // manifest is unreadable, so a question post decides with the session
    // token's stored grant.
    repoUrl: 'file:///nonexistent/telegram-v2.git',
  });
  await saveTelegramInstall({ projectId: PROJECT, botId: BOT_ID, username: 'synthetic_bot', token: TOKEN, webhookSecret: 's' });
  await allowSender();
  // The channel connector a question post is checked against, as connect writes it.
  const [connector] = await db
    .insert(connectors)
    .values({ accountId: ACCOUNT, projectId: PROJECT, slug: 'kortix_telegram', name: 'Telegram', providerType: 'channel', config: { platform: 'telegram' } })
    .returning({ connectorId: connectors.connectorId });
  CONNECTOR = connector!.connectorId;
  await db.insert(connectorActions).values({ connectorId: CONNECTOR, path: 'send_message', name: 'Send message', risk: 'write' });
  // The project's account, as sync seeds it for a channel connector.
  CONNECTION = await ensureDefaultConnection({ projectId: PROJECT, connectorId: CONNECTOR });
  restoreLifecycle();
});

/** The recorder seam; `overrides` replace single members for one test. */
function restoreLifecycle(overrides: Parameters<typeof setChannelLifecycleForTest>[0] = {}) {
  setChannelLifecycleForTest({
    resolveProjectAutomationActor: async () => actor,
    createSession: (async (input: Record<string, any>) => {
      created.push(input);
      if (duringCreate) await duringCreate();
      if (createThrows) throw new Error('synthetic create failure');
      if (createResult) return createResult;
      const sessionId = await newSession();
      const { type: _type, ...thread } = input.postCreate[0];
      await bindChatThread({ ...thread, projectId: PROJECT, sessionId });
      createdSessions.push(sessionId);
      return { status: 'created', sessionId };
    }) as never,
    deliverThroughQueue: (async (command: Record<string, any>) => {
      delivered.push(command);
      return deliverResult;
    }) as never,
    sleep: async () => {
      sleeps++;
      await onSleep?.();
    },
    ...overrides,
  });
}

beforeEach(() => {
  calls.length = 0;
  created.length = 0;
  createdSessions.length = 0;
  delivered.length = 0;
  createResult = null;
  createThrows = false;
  duringCreate = null;
  deliverResult = 'queued';
  actor = ACTOR;
  onSleep = null;
  onCall = null;
  webhookInfo = ownWebhook();
  failing = null;
  releaseOutcome = 'unreachable';
  releases.length = 0;
  sleeps = 0;
});

afterAll(async () => {
  resetChannelLifecycleForTest();
  fake.stop(true);
  await db.delete(chatThreads).where(eq(chatThreads.workspaceId, BOT_ID));
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `telegram:threadcreate:${PROJECT}:%`));
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, 'channel:start-retrying:%'));
  await db.delete(jobQueue).where(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`));
  await db.delete(sessionPendingQuestions).where(eq(sessionPendingQuestions.projectId, PROJECT));
  await db.delete(accountTokens).where(eq(accountTokens.projectId, PROJECT));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, PROJECT));
  await deleteFromView(db, accountMembers, eq(accountMembers.accountId, ACCOUNT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await deleteTelegramInstall(PROJECT);
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('Telegram channel connector — migrated PostgreSQL', () => {
  test('the inbox stores an update once: a provider retry is a no-op', async () => {
    const event = update('hello');
    expect(await emitIntegrationEvent(event)).toBe(true);
    expect(await emitIntegrationEvent(event)).toBe(false);
    const rows = await db
      .select({ key: jobQueue.jobKey })
      .from(jobQueue)
      .where(and(eq(jobQueue.queue, INTEGRATION_EVENTS_QUEUE), eq(jobQueue.jobKey, `telegram:${BOT_ID}:${event.id}`)));
    expect(rows).toHaveLength(1);
  });

  test('an unknown sender gets a pairing reply with their user id and starts no session', async () => {
    await handleTelegramEvent(update('let me in', '999'));
    expect(created).toHaveLength(0);
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(String(calls[0]!.body.text)).toContain('999');
  });

  test('an allowed sender in a new chat starts one project-visible session bound to the chat, then frees the chat', async () => {
    const event = update('summarize the release');
    await handleTelegramEvent(event);
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction']);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: 'telegram',
      visibility: 'project',
      userId: ACTOR,
      queuePolicy: 'on_backpressure',
      idempotencyKey: `telegram:create:${BOT_ID}:${event.id}`,
      body: { agent_name: 'default', title_source: 'summarize the release' },
      metadata: { source: 'telegram', telegram: { bot_id: BOT_ID, chat_id: 777 } },
      postCreate: [
        {
          type: 'bind_chat_thread',
          platform: 'telegram',
          workspaceId: BOT_ID,
          threadId: '777',
          createClaim: { key: claimKey(777), token: expect.any(String) },
        },
        { type: 'deliver_prompt', source: 'telegram', userId: ACTOR },
      ],
    });
    expect(created[0]!.body).not.toHaveProperty('initial_prompt');
    expect(created[0]!.postCreate[1].text).toContain('kortix_telegram.send_message');
    expect((await threadRow(777))?.sessionId).toBe(createdSessions[0]);
    // The create bound the chat, so its claim is spent: the next session start never waits on it.
    expect(await claimRows(777)).toHaveLength(0);
  });

  test('the next message in a bound chat follows up into its session under its own key; /new forgets the chat', async () => {
    const sessionId = await bindChat(888);
    const event = update('and the risks?', ALLOWED, 888);
    await handleTelegramEvent(event);
    expect(created).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      source: 'telegram',
      sessionId,
      projectId: PROJECT,
      idempotencyKey: `telegram:${BOT_ID}:${event.id}`,
    });
    expect(delivered[0]!.text).toContain('in the same chat');

    await holdClaim(888);
    await handleTelegramEvent(update('/new', ALLOWED, 888));
    expect(await threadRow(888)).toBeUndefined();
    expect(await claimRows(888)).toHaveLength(0);
    expect(replies().at(-1)).toContain('Started a new conversation');
  });

  test('message, /new, message: two sessions, and the second starts at once', async () => {
    await handleTelegramEvent(update('first', ALLOWED, 910));
    expect(await claimRows(910)).toHaveLength(0);
    await handleTelegramEvent(update('/new', ALLOWED, 910));
    await handleTelegramEvent(update('second', ALLOWED, 910));
    expect(created).toHaveLength(2);
    expect(sleeps).toBe(0);
    expect(replies().join('\n')).not.toContain('still starting');
    expect((await threadRow(910))?.sessionId).toBe(createdSessions[1]);
  });

  test('a chat whose session is gone starts a new session and rebinds the chat', async () => {
    const old = await bindChat(914);
    deliverResult = 'no-session';
    await handleTelegramEvent(update('still there?', ALLOWED, 914));
    expect(delivered).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.postCreate[1].text).toStartWith('You received a message on Telegram.');
    const thread = await threadRow(914);
    expect(thread?.sessionId).toBe(createdSessions[0]);
    expect(thread?.sessionId).not.toBe(old);
  });

  test('a message racing a create waits for its thread, then follows up into that session', async () => {
    await holdClaim(915);
    let winner = '';
    onSleep = async () => {
      if (!winner) winner = await bindChat(915);
    };
    const event = update('me too', ALLOWED, 915);
    await handleTelegramEvent(event);
    expect(created).toHaveLength(0);
    expect(sleeps).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ sessionId: winner, idempotencyKey: `telegram:${BOT_ID}:${event.id}` });
  });

  test('a racing create bound the chat to a session that cannot take the message: retry, then drop on the last attempt', async () => {
    await holdClaim(937);
    onSleep = async () => {
      if (!(await threadRow(937))) await bindChat(937);
    };
    deliverResult = 'no-session';
    const event = update('me too', ALLOWED, 937);
    await expect(handleTelegramEvent(event)).rejects.toThrow('cannot take the message');
    await handleTelegramEvent(event, { finalAttempt: true });
    expect(created).toHaveLength(0);
  });

  test('a message whose racing create bound the chat and freed its claim follows up instead of creating', async () => {
    // Between this message's lookup and its claim, another message's create
    // bound the chat and released its claim (the actor lookup runs in between).
    let winner = '';
    restoreLifecycle({
      resolveProjectAutomationActor: async () => {
        winner = await bindChat(919);
        return ACTOR;
      },
    });
    try {
      await handleTelegramEvent(update('me as well', ALLOWED, 919));
    } finally {
      restoreLifecycle();
    }
    expect(created).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe(winner);
    expect(await claimRows(919)).toHaveLength(0);
  });

  test('two messages that both saw a dead session start one new session, not two', async () => {
    const dead = await bindChat(960);
    const first = update('one', ALLOWED, 960);
    const second = update('two', ALLOWED, 960);
    // The second message reads the dead session; while its delivery is refused,
    // the first message revives the chat. The second must then follow up into
    // that new session instead of dropping its mapping and creating another.
    restoreLifecycle({
      deliverThroughQueue: (async (command: Record<string, any>) => {
        delivered.push(command);
        if (command.sessionId !== dead) return 'queued';
        if (command.idempotencyKey === `telegram:${BOT_ID}:${second.id}`) await handleTelegramEvent(first);
        return 'no-session';
      }) as never,
    });
    try {
      await handleTelegramEvent(second);
    } finally {
      restoreLifecycle();
    }
    expect(createdSessions).toHaveLength(1);
    expect((await threadRow(960))?.sessionId).toBe(createdSessions[0]);
    const intoNew = delivered.filter((d) => d.sessionId === createdSessions[0]);
    expect(intoNew).toHaveLength(1);
    expect(intoNew[0]!.idempotencyKey).toBe(`telegram:${BOT_ID}:${second.id}`);
  });

  test('a project with no owner starts nothing and holds no claim', async () => {
    actor = null;
    await handleTelegramEvent(update('hello', ALLOWED, 918));
    expect(created).toHaveLength(0);
    expect(await claimRows(918)).toHaveLength(0);
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction']);
  });

  test('a failed session: retry, and on the last attempt tell the chat to start over', async () => {
    await bindChat(913);
    deliverResult = 'failed';
    await expect(handleTelegramEvent(update('hello?', ALLOWED, 913))).rejects.toThrow('telegram follow-up failed');
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction']);

    calls.length = 0;
    await handleTelegramEvent(update('hello?', ALLOWED, 913), { finalAttempt: true });
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(replies()[0]).toContain('/new');
    expect(created).toHaveLength(0);
  });

  test('a create the lifecycle requeued keeps the chat claimed; a final failure says why and frees it', async () => {
    createResult = { status: 'failed', retryable: true, requeued: true, error: { status: 503, body: { error: 'clone failed' } } };
    await handleTelegramEvent(update('first try', ALLOWED, 901));
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(replies()[0]).toContain('still starting a session');
    expect(await claimRows(901)).toHaveLength(1);

    calls.length = 0;
    createResult = { status: 'failed', retryable: false, error: { status: 402, body: { error: 'no credits' } } };
    await handleTelegramEvent(update('second try', ALLOWED, 902));
    expect(replies().at(-1)).toContain('out of credits');
    expect(await claimRows(902)).toHaveLength(0);
  });

  test('a create queued behind other sessions says so and keeps the chat claimed', async () => {
    createResult = { status: 'queued', commandId: 'cmd-1', retryable: true };
    await handleTelegramEvent(update('busy?', ALLOWED, 916));
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(replies()[0]).toContain('still starting');
    expect(await claimRows(916)).toHaveLength(1);
  });

  test('a create that throws frees the chat, so the retry creates under the same key', async () => {
    createThrows = true;
    const event = update('try me', ALLOWED, 917);
    await expect(handleTelegramEvent(event)).rejects.toThrow('synthetic create failure');
    expect(await claimRows(917)).toHaveLength(0);

    createThrows = false;
    await handleTelegramEvent(event);
    expect(created).toHaveLength(2);
    expect(created[1]!.idempotencyKey).toBe(created[0]!.idempotencyKey);
    expect(sleeps).toBe(0);
  });

  test('a retry of a message whose create the lifecycle took routes nothing: its first prompt arrives once', async () => {
    for (const [chat, status] of [[930, 'queued'], [931, 'running'], [932, 'succeeded']] as const) {
      await bindChat(chat);
      const event = update('deliver me once', ALLOWED, chat);
      await createCommand(event, status);
      await handleTelegramEvent(event);
      await handleTelegramEvent(event, { finalAttempt: true });
    }
    expect(created).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(sleeps).toBe(0);
    expect(replies()).toHaveLength(0);
  });

  test('a message whose create the lifecycle gave up routes again', async () => {
    await bindChat(933);
    const event = update('try again', ALLOWED, 933);
    await createCommand(event, 'dead_lettered');
    await handleTelegramEvent(event);
    expect(delivered).toHaveLength(1);
  });

  test('a create row of the same key in another project is not this message', async () => {
    const other = crypto.randomUUID();
    await db.insert(projects).values({ projectId: other, accountId: ACCOUNT, name: 'telegram-v2-other', repoUrl: 'https://example.test/o.git' });
    try {
      const event = update('mine', ALLOWED, 934);
      await createCommand(event, 'running', other);
      await handleTelegramEvent(event);
      expect(created).toHaveLength(1);
    } finally {
      await db.delete(projects).where(eq(projects.projectId, other));
    }
  });

  test('a create that throws after the bind: the retry delivers nothing twice', async () => {
    const event = update('bind then fail', ALLOWED, 935);
    // The lifecycle wrote its row and bound the chat, then a later write threw.
    duringCreate = async () => {
      await createCommand(event, 'running');
      await bindChat(935);
    };
    createThrows = true;
    await expect(handleTelegramEvent(event)).rejects.toThrow('synthetic create failure');
    createThrows = false;
    duringCreate = null;
    await handleTelegramEvent(event);
    expect(created).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  test('a create that throws after the lifecycle took it keeps the chat claimed: no second session meanwhile', async () => {
    const event = update('queued then fail', ALLOWED, 936);
    duringCreate = () => createCommand(event, 'queued');
    createThrows = true;
    await expect(handleTelegramEvent(event)).rejects.toThrow('synthetic create failure');
    expect(await claimRows(936)).toHaveLength(1);

    createThrows = false;
    duringCreate = null;
    await expect(handleTelegramEvent(update('anyone?', ALLOWED, 936))).rejects.toThrow('in flight');
    expect(created).toHaveLength(1);
  });

  test('the lifecycle frees a chat create claim once its bind lands, and only its own', async () => {
    const bindWith = (chat: number, createClaim?: { key: string; token: string }) =>
      newSession().then((sessionId) =>
        applyPostCreateActions({
          projectId: PROJECT,
          sessionId,
          actions: [{ type: 'bind_chat_thread', platform: 'telegram', workspaceId: BOT_ID, threadId: String(chat), createClaim }],
        }),
      );

    const token = (await claimThreadCreate(claimKey(941)))!;
    expect(await bindWith(941, { key: claimKey(941), token: token.toISOString() })).toEqual({ ok: true });
    expect((await threadRow(941))?.sessionId).toBeDefined();
    expect(await claimRows(941)).toHaveLength(0);

    // Another create took the claim over: its owner token differs, so it stays.
    await holdClaim(942);
    expect(await bindWith(942, { key: claimKey(942), token: new Date(Date.now() + 1).toISOString() })).toEqual({ ok: true });
    expect(await claimRows(942)).toHaveLength(1);

    // A bind queued before the field existed carries no claim: nothing is freed.
    await holdClaim(943);
    expect(await bindWith(943)).toEqual({ ok: true });
    expect(await claimRows(943)).toHaveLength(1);
  });

  test('a chat create the lifecycle gives up frees the chat at once', async () => {
    const archived = crypto.randomUUID();
    await db.insert(projects).values({
      projectId: archived,
      accountId: ACCOUNT,
      name: 'telegram-v2-archived',
      repoUrl: 'https://example.test/a.git',
      status: 'archived',
    });
    try {
      const [project] = await db.select().from(projects).where(eq(projects.projectId, archived));
      const token = (await claimThreadCreate(claimKey(944)))!;
      const idempotencyKey = `telegram:create:${BOT_ID}:dead-letter-${crypto.randomUUID()}`;
      const result = await createSession({
        source: 'telegram',
        project: project!,
        userId: ACTOR,
        requestingPrincipalType: 'human',
        body: {},
        visibility: 'project',
        metadata: {},
        queuePolicy: 'never',
        idempotencyKey,
        postCreate: [
          { type: 'bind_chat_thread', platform: 'telegram', workspaceId: BOT_ID, threadId: '944', createClaim: { key: claimKey(944), token: token.toISOString() } },
        ],
      });
      expect(result.error?.body.code).toBe('project_archived');
      expect(await createCommandStatus(idempotencyKey, archived)).toBe('dead_lettered');
      expect(await claimRows(944)).toHaveLength(0);
    } finally {
      await db.delete(projects).where(eq(projects.projectId, archived));
    }
  });

  test('a chat whose first session is still starting: wait 8 s, retry, and on the last attempt say so', async () => {
    await holdClaim(903);
    await expect(handleTelegramEvent(update('are you there?', ALLOWED, 903))).rejects.toThrow('in flight');
    expect(sleeps).toBe(32);

    calls.length = 0;
    await handleTelegramEvent(update('are you there?', ALLOWED, 903), { finalAttempt: true });
    expect(created).toHaveLength(0);
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(replies()[0]).toContain('Send your message again');
  });

  test('an expired claim (a create that never finished) is taken over', async () => {
    await holdClaim(911, -1_000);
    await handleTelegramEvent(update('anyone?', ALLOWED, 911));
    expect(created).toHaveLength(1);
    expect(sleeps).toBe(0);
    expect(await claimRows(911)).toHaveLength(0);
  });

  test('a claim taken over during a long create stays with its new owner', async () => {
    const later = new Date(Date.now() + 3_600_000);
    duringCreate = () => db.update(chatEventDedup).set({ expiresAt: later }).where(eq(chatEventDedup.eventId, claimKey(912)));
    await handleTelegramEvent(update('slow', ALLOWED, 912));
    const rows = await claimRows(912);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt.getTime()).toBe(later.getTime());
  });

  test('the kortix_telegram connector counts as connected exactly while the project has an install', async () => {
    const check = (projectId: string) =>
      connectorConnectionIsConnected({
        connector: { connectorId: crypto.randomUUID(), projectId, slug: 'kortix_telegram', name: 'Telegram', providerType: 'channel', config: { platform: 'telegram' }, enabled: true, status: 'active' },
        connection: { connectionId: crypto.randomUUID(), isDefault: false, ownerType: 'project', ownerId: projectId, status: 'active', metadata: {} },
      } as never);
    expect(await check(PROJECT)).toBe(true);
    expect(await check(crypto.randomUUID())).toBe(false);
  });

  test('allowed users are replaced, not merged', async () => {
    await setTelegramAllowedUserIds(PROJECT, ['5', '6']);
    const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
    expect((row!.metadata as any).telegram.allowedUserIds).toEqual(['5', '6']);
    await allowSender();
  });
});

describe('Telegram notices addressed by session — migrated PostgreSQL', () => {
  const credits = { name: 'APIError', statusCode: 402, message: 'Payment Required: Insufficient credits.' };
  const runFailed = (sessionId: string, error: Record<string, unknown> = credits) =>
    notifySessionChannel({ kind: 'run_failed', sessionId, error });
  const bind = (sessionId: string, threadId: string, platform = 'telegram', workspaceId = BOT_ID) =>
    bindChatThread({ projectId: PROJECT, platform, workspaceId, threadId, sessionId });

  test('a run error reaches the chat once, unanchored, as the title, the next step and the session link', async () => {
    const sessionId = await bindChat(940);
    await runFailed(sessionId);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        body: {
          chat_id: 940,
          text: [
            'Kortix could not finish this run: Out of credits.',
            'A workspace admin can top up credits in Kortix. Then send your message again.',
            `Details: ${sessionWebUrl(appConfig.FRONTEND_URL, PROJECT, sessionId)}`,
          ].join('\n'),
        },
      },
    ]);
  });

  test('a stopped run, and a chat that sent /new, hear nothing', async () => {
    const stopped = await bindChat(941);
    await runFailed(stopped, { name: 'MessageAbortedError', message: '' });
    const left = await bindChat(942);
    await forgetChatThread(
      { platform: 'telegram', workspaceId: BOT_ID, threadId: '942', projectId: PROJECT },
      claimKey(942),
    );
    await runFailed(left);
    expect(calls).toEqual([]);
  });

  test('a forum topic gets the notice in its topic', async () => {
    const sessionId = await newSession();
    await bind(sessionId, '-100940:7');
    await runFailed(sessionId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ chat_id: -100940, text: expect.any(String), message_thread_id: 7 });
  });

  test('a session that adopted the chat (a reminder successor) reaches it', async () => {
    const failed = await bindChat(944);
    const successor = await newSession();
    await adoptChatThreads(PROJECT, failed, successor);
    await runFailed(successor);
    expect(calls.map((c) => c.body.chat_id)).toEqual([944]);
  });

  test('a session with only Slack or Email threads, or a chat of a bot this project no longer has, hears nothing', async () => {
    const elsewhere = await newSession();
    await bind(elsewhere, 'C1:1.0', 'slack', 'T-synthetic');
    await bind(elsewhere, 'thread-1', 'email', 'inbox-synthetic');
    await runFailed(elsewhere);
    const oldBot = await newSession();
    await bind(oldBot, '945', 'telegram', 'other-bot');
    await runFailed(oldBot);
    expect(calls).toEqual([]);
  });

  test('a session in two chats tells the one it talked in last', async () => {
    // The chat bound first is the older one, so a lookup that ignored the
    // last-message order would pick it.
    const sessionId = await bindChat(946);
    await bind(sessionId, '947');
    await db
      .update(chatThreads)
      .set({ lastMessageAt: new Date(Date.now() - 60_000) })
      .where(and(eq(chatThreads.workspaceId, BOT_ID), eq(chatThreads.threadId, '946')));
    await runFailed(sessionId);
    expect(calls.map((c) => c.body.chat_id)).toEqual([947]);
  });

  test('a run the chat did not prompt (the web, a reminder) is not told to it; an unknown source still is', async () => {
    const sessionId = await bindChat(952);
    const notify = (promptSource: string | null) =>
      notifySessionChannel({ kind: 'run_failed', sessionId, error: credits, promptSource });
    await notify('ui');
    await notify('trigger:reminder');
    expect(calls).toEqual([]);
    await notify('telegram');
    await notify(null);
    expect(calls.map((c) => c.body.chat_id)).toEqual([952, 952]);
  });

  test('the prompt source of a turn is the newest lifecycle prompt its message id names', async () => {
    const sessionId = await newSession();
    const prompt = (source: string, wireMessageId: string) =>
      db.insert(sessionLifecycleCommands).values({
        commandType: 'continue_session',
        source,
        projectId: PROJECT,
        accountId: ACCOUNT,
        sessionId,
        payload: { wireMessageId },
      });
    await prompt('telegram', 'msg_chat');
    await prompt('ui', 'msg_web');
    expect(await turnPromptSource(sessionId, 'msg_chat')).toBe('telegram');
    expect(await turnPromptSource(sessionId, 'msg_web')).toBe('ui');
    expect(await turnPromptSource(sessionId, 'msg_unknown')).toBeNull();
    expect(await turnPromptSource(sessionId, null)).toBeNull();
  });

  test('a sandbox that cannot start says so once, with its classified reason, and asks for /new', async () => {
    const sessionId = await bindChat(948);
    const reason = "Couldn't access the project's Git repository. Check the project's Git credentials and try again.";
    await notifyStartFailure(sessionId, reason, { transient: false });
    expect(calls).toHaveLength(1);
    const text = String(calls[0]!.body.text);
    expect(text).toContain(reason);
    expect(text).toContain('Send /new');
    expect(text).toContain(`/projects/${PROJECT}/sessions/${sessionId}`);
  });

  test('a failure the provider may clear is told once, as retrying; a final failure still is', async () => {
    const sessionId = await bindChat(951);
    const capacity = 'The compute provider is at capacity right now.';
    await notifyStartFailure(sessionId, capacity, { transient: true });
    await notifyStartFailure(sessionId, capacity, { transient: true });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.body.text)).toStartWith(`Kortix could not start this chat's session yet. ${capacity}\n`);
    expect(String(calls[0]!.body.text)).toContain('If the agent does not reply, send /new');
    await notifyStartFailure(sessionId, capacity, { transient: false });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.body.text)).toStartWith("Kortix could not start this chat's session, so the agent did not run.");
  });

  test('a web session that fails to start writes no once-claim', async () => {
    const webSession = await newSession();
    await notifyStartFailure(webSession, 'at capacity', { transient: true });
    expect(calls).toEqual([]);
    expect(await db.select().from(chatEventDedup).where(eq(chatEventDedup.eventId, `channel:start-retrying:${webSession}`))).toEqual([]);
  });

  test('a kick-off failure posts the generic copy, never its internal text', async () => {
    const sessionId = await bindChat(949);
    await notifyStartFailure(sessionId, 'connect ECONNREFUSED 10.0.0.1:5432');
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.body.text)).not.toContain('ECONNREFUSED');
    expect(String(calls[0]!.body.text)).toStartWith("Kortix could not start this chat's session, so the agent did not run.\n");
  });

  test('provisioning failures reach the chat through the registered notifier', async () => {
    const sessionId = await bindChat(950);
    const sent = nextCall();
    notifySessionProvisioningFailed(sessionId, 'x', { transient: false });
    expect((await sent).body.chat_id).toBe(950);
  });
});

const QUESTION = [{ header: 'Pick', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];

/** A stored question of a session; `open`: the server could not release it (the turn still waits). */
async function pending(sessionId: string, opts: { open?: boolean } = {}) {
  const [row] = await db
    .insert(sessionPendingQuestions)
    .values({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId,
      requestId: `que_${crypto.randomUUID()}`,
      questions: QUESTION,
      ...(opts.open ? {} : { answeredAt: new Date().toISOString() }),
    })
    .returning({ id: sessionPendingQuestions.id });
  return row!.id;
}

/** A press on a question button, as the webhook stores it. */
function press(data: string, opts: { chat?: number; from?: string; messageId?: number; topic?: number } = {}) {
  const chat = opts.chat ?? 777;
  return telegramPressEvent(PROJECT, BOT_ID, {
    update_id: updateId++,
    callback_query: {
      id: `cbq-${crypto.randomUUID()}`,
      from: { id: Number(opts.from ?? ALLOWED), username: 'synthetic' },
      data,
      message: {
        message_id: opts.messageId ?? 50,
        chat: { id: chat, type: opts.topic ? 'supergroup' : 'private' },
        ...(opts.topic ? { message_thread_id: opts.topic, is_topic_message: true } : {}),
      },
    },
  })!;
}
const methods = () => calls.map((c) => c.method);
const POSTED = [[questionReleaseSentinel('telegram', true)]];
const FULL_GRANT = { agent: 'default', permissions: 'all', connectors: 'all' };
const tokens = new Map<string, string>();

/**
 * A Telegram session bound to a chat (`<chat>` or `<chat>:<topic>`), with a
 * live sandbox and the session token it holds: its stored grant names the
 * agent's policy set.
 */
async function askedSession(threadId: string, opts: { grant?: Record<string, unknown>; bot?: string; createdBy?: string; source?: string } = {}) {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    createdBy: opts.createdBy ?? ACTOR,
    metadata: { source: opts.source ?? 'telegram' },
  });
  await bindChatThread({ projectId: PROJECT, platform: 'telegram', workspaceId: opts.bot ?? BOT_ID, threadId, sessionId });
  // A live sandbox: a session token holds only while its sandbox does.
  await db.insert(sessionSandboxes).values({ sandboxId: sessionId, sessionId, accountId: ACCOUNT, projectId: PROJECT, status: 'active' });
  const token = await createAccountToken({
    accountId: ACCOUNT,
    userId: ACTOR,
    projectId: PROJECT,
    sessionId,
    name: 'session',
    agentGrant: (opts.grant ?? FULL_GRANT) as never,
  });
  tokens.set(sessionId, token.secretKey);
  return sessionId;
}

/** The connector principal the session's sandbox token names, as the turn-question route resolves it. */
async function principalOf(sessionId: string) {
  const principal = await resolveTokenPrincipal(tokens.get(sessionId)!, sessionId);
  if (!principal) throw new Error('no principal for the session token');
  return principal;
}

describe('Telegram questions posted by the server — migrated PostgreSQL', () => {
  /** Ask through the relay as the turn-question route does for the session's sandbox. */
  const ask = async (sessionId: string, questions: unknown[] = QUESTION) =>
    relayTurnQuestion(sessionId, questions as never, { pendingId: await pending(sessionId), principal: await principalOf(sessionId) });
  const setMode = (defaultMode: 'risk' | 'allow_all') =>
    db
      .insert(connectorProjectSettings)
      .values({ projectId: PROJECT, defaultMode })
      .onConflictDoUpdate({ target: connectorProjectSettings.projectId, set: { defaultMode } });
  const rule = (action: 'always_run' | 'require_approval', conditions: Array<{ arg: string; match: string }> | null = null) =>
    db.insert(connectorProjectPolicies).values({ projectId: PROJECT, match: 'kortix_telegram.send_message', action, conditions });
  const clearRules = () => db.delete(connectorProjectPolicies).where(eq(connectorProjectPolicies.projectId, PROJECT));

  afterEach(async () => {
    await clearRules();
    await db.delete(connectorProjectSettings).where(eq(connectorProjectSettings.projectId, PROJECT));
    await db.delete(connectorPolicySets).where(eq(connectorPolicySets.connectorId, CONNECTOR));
    await db.delete(connectorPolicies).where(eq(connectorPolicies.connectorId, CONNECTOR));
    await db.update(connectors).set({ enabled: true, status: 'active', config: { platform: 'telegram' } }).where(eq(connectors.connectorId, CONNECTOR));
    await db.update(connectorConnections).set({ status: 'active' }).where(eq(connectorConnections.connectionId, CONNECTION));
  });

  test('one question with up to six options gets a button per option, and a tap on one answers it', async () => {
    const sessionId = await askedSession('981');
    const id = await pending(sessionId);
    expect(await relayTurnQuestion(sessionId, QUESTION as never, { pendingId: id, principal: await principalOf(sessionId) })).toEqual({ ok: true, answers: POSTED });
    expect(methods()).toEqual(['getWebhookInfo', 'sendMessage']);
    const sent = calls[1]!.body as { chat_id: unknown; text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    expect(sent.chat_id).toBe('981');
    expect(sent.text).toBe('Pick: Which database?\n1. Postgres\n2. SQLite\n\nTap an option, or reply to this message with your own answer.');
    expect(sent.reply_markup.inline_keyboard).toEqual([
      [{ text: 'Postgres', callback_data: `kq:${id}:0` }],
      [{ text: 'SQLite', callback_data: `kq:${id}:1` }],
    ]);
    for (const [button] of sent.reply_markup.inline_keyboard) expect(Buffer.byteLength(button!.callback_data)).toBeLessThanOrEqual(64);

    await handleTelegramPress(press(sent.reply_markup.inline_keyboard[1]![0]!.callback_data, { chat: 981 }));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe(sessionId);
    expect(delivered[0]!.text).toContain('You asked:\n> Which database?\n\nSQLite');
  });

  test('a question in a forum topic is posted into that topic', async () => {
    const sessionId = await askedSession('-100982:7');
    expect(await ask(sessionId)).toMatchObject({ ok: true });
    expect(calls.at(-1)!.body).toMatchObject({ chat_id: '-100982', message_thread_id: 7 });
  });

  test('two questions, a multi-select or more than six options are a numbered list to reply to', async () => {
    const sessionId = await askedSession('983');
    const options = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}`, description: '' }));
    for (const questions of [
      [QUESTION[0], { header: '', question: 'Which region?', options: options(2) }],
      [{ header: '', question: 'Which features?', options: options(3), multiple: true }],
      [{ header: '', question: 'Which size?', options: options(7) }],
    ]) {
      expect(await ask(sessionId, questions)).toEqual({ ok: true, answers: questions.map(() => POSTED[0]!) });
    }
    // No buttons, so no look at the webhook either.
    expect(methods()).toEqual(['sendMessage', 'sendMessage', 'sendMessage']);
    expect(calls.some((c) => 'reply_markup' in c.body)).toBe(false);
    const [two, multiple, seven] = calls.map((c) => String(c.body.text));
    expect(two).toBe(
      '1) Pick: Which database?\n1. Postgres\n2. SQLite\n\n2) Which region?\n1. Option 1\n2. Option 2\n\nReply to this message with your answer, each question by its number.',
    );
    expect(multiple).toStartWith('Which features? (pick one or more)\n1. Option 1\n');
    expect(seven).toContain('\n7. Option 7\n');
    expect(seven).toEndWith('\n\nReply to this message with your answer.');
  });

  test('nothing is posted without a stored question, after /new, or into a chat of a replaced bot', async () => {
    const sessionId = await askedSession('984');
    expect(await relayTurnQuestion(sessionId, QUESTION as never)).toEqual({ ok: false, error: 'not_relayed' });
    await forgetChatThread({ platform: 'telegram', workspaceId: BOT_ID, threadId: '984', projectId: PROJECT }, 'unused');
    expect(await ask(sessionId)).toEqual({ ok: false, error: 'not_relayed' });
    expect(await ask(await askedSession('985', { bot: 'replaced-bot' }))).toEqual({ ok: false, error: 'not_relayed' });
    expect(calls).toEqual([]);
  });

  test("the question stays with the agent where its send_message needs approval: the risk mode, a rule for the chat, a disabled connector", async () => {
    const sessionId = await askedSession('986');
    const posted = async () => (await ask(sessionId)).ok;
    await setMode('risk');
    expect(await posted()).toBe(false);
    await rule('always_run');
    expect(await posted()).toBe(true);
    await clearRules();
    await setMode('allow_all');
    await rule('require_approval', [{ arg: 'chat_id', match: '986' }]);
    expect(await posted()).toBe(false);
    await clearRules();
    await rule('require_approval', [{ arg: 'chat_id', match: '999' }]);
    expect(await posted()).toBe(true);
    await db.update(connectors).set({ enabled: false }).where(eq(connectors.connectorId, CONNECTOR));
    expect(await posted()).toBe(false);
    // A refused post makes no Bot API call at all.
    expect(methods()).toEqual(['getWebhookInfo', 'sendMessage', 'getWebhookInfo', 'sendMessage']);
  });

  test("the agent's policy set decides, and a set the connector does not define refuses", async () => {
    const sessionId = await askedSession('987', { grant: { ...FULL_GRANT, policySets: { kortix_telegram: 'strict' } } });
    expect((await ask(sessionId)).ok).toBe(false);
    await db.insert(connectorPolicySets).values({ connectorId: CONNECTOR, name: 'strict', policies: [{ match: 'send_message', action: 'require_approval' }] });
    expect((await ask(sessionId)).ok).toBe(false);
    await db
      .update(connectorPolicySets)
      .set({ policies: [{ match: 'send_message', action: 'always_run' }] })
      .where(eq(connectorPolicySets.connectorId, CONNECTOR));
    expect((await ask(sessionId)).ok).toBe(true);
    expect(methods()).toEqual(['getWebhookInfo', 'sendMessage']);
  });

  test("the agent's connector account decides too: a revoked account, a connector that needs sign-in, another session's principal", async () => {
    const sessionId = await askedSession('2001');
    const posted = async () => (await ask(sessionId)).ok;
    expect(await posted()).toBe(true);
    calls.length = 0;
    await db.update(connectorConnections).set({ status: 'revoked' }).where(eq(connectorConnections.connectionId, CONNECTION));
    expect(await posted()).toBe(false);
    await db.update(connectorConnections).set({ status: 'active' }).where(eq(connectorConnections.connectionId, CONNECTION));
    await db.update(connectors).set({ status: 'needs_auth' }).where(eq(connectors.connectorId, CONNECTOR));
    expect(await posted()).toBe(false);
    await db.update(connectors).set({ status: 'active' }).where(eq(connectors.connectorId, CONNECTOR));
    const other = await askedSession('2002');
    expect(await relayTurnQuestion(sessionId, QUESTION as never, { pendingId: await pending(sessionId), principal: await principalOf(other) })).toEqual({
      ok: false,
      error: 'not_relayed',
    });
    expect(calls).toEqual([]);
  });

  test('an agent not assigned the connector posts nothing in a chat its session did not start from', async () => {
    // An Email session bound to a Telegram chat, whose agent may use no connector.
    const sessionId = await askedSession('2004', { source: 'email', grant: { ...FULL_GRANT, connectors: [] } });
    expect(await ask(sessionId)).toEqual({ ok: false, error: 'not_relayed' });
    expect(calls).toEqual([]);
  });

  test("the connector's own rules and its sensitive flag decide too", async () => {
    const sessionId = await askedSession('2003');
    await db.insert(connectorPolicies).values({ connectorId: CONNECTOR, match: 'send_message', action: 'require_approval' });
    expect((await ask(sessionId)).ok).toBe(false);
    await db.delete(connectorPolicies).where(eq(connectorPolicies.connectorId, CONNECTOR));
    await db.update(connectors).set({ config: { platform: 'telegram', sensitive: true } }).where(eq(connectors.connectorId, CONNECTOR));
    expect((await ask(sessionId)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test('a bot connected before buttons is subscribed to presses on its own webhook, with its own secret', async () => {
    const sessionId = await askedSession('988');
    webhookInfo = { ...ownWebhook(), allowed_updates: ['message'] };
    expect(await ask(sessionId)).toEqual({ ok: true, answers: POSTED });
    expect(methods()).toEqual(['getWebhookInfo', 'setWebhook', 'sendMessage']);
    // No drop_pending_updates: the messages Telegram still holds are delivered.
    expect(calls[1]!.body).toEqual({ url: ownWebhook().url, secret_token: 's', allowed_updates: ['message', 'callback_query'] });
    expect(calls[2]!.body).toHaveProperty('reply_markup');
    // Telegram's default set (no allowed_updates) carries presses already.
    calls.length = 0;
    webhookInfo = { url: ownWebhook().url };
    await ask(sessionId);
    expect(methods()).toEqual(['getWebhookInfo', 'sendMessage']);
    expect(calls[1]!.body).toHaveProperty('reply_markup');
  });

  test('a webhook this project does not own, or a failed subscription, gets the question as text', async () => {
    const sessionId = await askedSession('989');
    for (const info of [{ url: '' }, { url: `https://example.test/v1/webhooks/telegram/${crypto.randomUUID()}`, allowed_updates: ['message'] }]) {
      calls.length = 0;
      webhookInfo = info;
      expect(await ask(sessionId)).toEqual({ ok: true, answers: POSTED });
      expect(methods()).toEqual(['getWebhookInfo', 'sendMessage']);
      expect(calls[1]!.body).not.toHaveProperty('reply_markup');
      expect(String(calls[1]!.body.text)).toEndWith('Reply to this message with your answer.');
    }
    calls.length = 0;
    webhookInfo = { ...ownWebhook(), allowed_updates: ['message'] };
    failing = 'setWebhook';
    expect(await ask(sessionId)).toEqual({ ok: true, answers: POSTED });
    expect(methods()).toEqual(['getWebhookInfo', 'setWebhook', 'sendMessage']);
    expect(calls[2]!.body).not.toHaveProperty('reply_markup');
  });

  test('a send Telegram refuses is not posted, so the agent asks in its own words', async () => {
    const sessionId = await askedSession('991');
    failing = 'sendMessage';
    expect(await ask(sessionId)).toEqual({ ok: false, error: 'not_relayed' });
  });
});

describe('POST /turn-question for a Telegram session — migrated PostgreSQL', () => {
  registerTurnQuestionsRoutes();
  const OWNER = crypto.randomUUID();
  const request = (ctx: Record<string, unknown>, body: Record<string, unknown>, bearer?: string) => {
    const app = new Hono<{ Variables: Record<string, unknown> }>();
    app.use('*', async (c, next) => {
      for (const [key, value] of Object.entries(ctx)) c.set(key, value);
      await next();
    });
    app.route('/v1/projects', projectsApp);
    return app.request(`/v1/projects/${PROJECT}/turn-question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  };

  test("only the session's own sandbox posts the question in the chat; a member's token stores it and posts nothing", async () => {
    await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
    const sessionId = await askedSession('990', { createdBy: OWNER });
    const body = (requestId?: string) => ({ session_id: sessionId, ...(requestId ? { request_id: requestId } : {}), questions: QUESTION });
    const sandbox = { userId: ACCOUNT, accountId: ACCOUNT, authType: 'apiKey', apiKeyType: 'sandbox', sandboxId: sessionId };

    const member = await request({ userId: OWNER, authType: 'jwt' }, body('que_member'));
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ ok: true, persisted: true, answers: [], channel_error: 'not_relayed' });
    // No runtime request id: the shared `q-<session>` row names no single question.
    const unnamed = await request(sandbox, body(), tokens.get(sessionId));
    expect(await unnamed.json()).toEqual({ ok: true, persisted: true, answers: [], channel_error: 'not_relayed' });
    expect(calls).toEqual([]);

    const posted = await request(sandbox, body('que_sandbox'), tokens.get(sessionId));
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ ok: true, persisted: true, answers: POSTED });
    const stored = await db
      .select({ id: sessionPendingQuestions.id, requestId: sessionPendingQuestions.requestId })
      .from(sessionPendingQuestions)
      .where(eq(sessionPendingQuestions.sessionId, sessionId));
    expect(stored.map((r) => r.requestId).sort()).toEqual(['que_member', 'que_sandbox', `q-${sessionId}`].sort());
    const id = stored.find((r) => r.requestId === 'que_sandbox')!.id;
    expect(methods()).toEqual(['getWebhookInfo', 'sendMessage']);
    expect(calls[1]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Postgres', callback_data: `kq:${id}:0` }], [{ text: 'SQLite', callback_data: `kq:${id}:1` }]],
    });
  });
});

describe('Telegram question buttons — migrated PostgreSQL', () => {
  test('an allowed press answers the question: the tap is acknowledged, the buttons go, and the answer follows up', async () => {
    const sessionId = await bindChat(970);
    const id = await pending(sessionId);
    const event = press(`kq:${id}:1`, { chat: 970 });
    await handleTelegramPress(event);

    expect(methods()).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(calls[0]!.body).toMatchObject({ text: 'Answered: SQLite' });
    expect(calls[1]!.body).toMatchObject({ chat_id: 970, message_id: 50, reply_markup: { inline_keyboard: [] } });
    expect(String(calls[1]!.body.text)).toEndWith('Answered: SQLite');
    expect(created).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ sessionId, idempotencyKey: `telegram:${BOT_ID}:${event.id}` });
    expect(delivered[0]!.text).toContain('You asked:\n> Which database?\n\nSQLite');
  });

  test('the stored press is a projection: no names, no question text, and no `message` key an old consumer would read', () => {
    const event = telegramPressEvent(PROJECT, BOT_ID, {
      update_id: updateId++,
      callback_query: {
        id: 'cbq-projection',
        from: { id: Number(ALLOWED), username: 'synthetic', first_name: 'Private', last_name: 'Person', language_code: 'hr' },
        chat_instance: 'ci-1',
        data: 'kq:00000000-0000-0000-0000-000000000000:0',
        message: {
          message_id: 50,
          date: 1_760_000_000,
          chat: { id: 777, type: 'group', title: 'Private group' },
          from: { id: Number(BOT_ID), is_bot: true, first_name: 'Bot name' },
          text: 'Pick: a private question',
        },
      },
    } as never)!;
    expect(event).toMatchObject({ type: 'telegram.callback_query.created', source: `telegram:${BOT_ID}`, subject: '777' });
    expect(Object.keys(event.data)).toEqual(['callback_query']);
    expect(event.data.callback_query).toEqual({
      id: 'cbq-projection',
      from: { id: Number(ALLOWED), username: 'synthetic' },
      data: 'kq:00000000-0000-0000-0000-000000000000:0',
      message: { message_id: 50, chat: { id: 777, type: 'group' } },
    });
    expect(JSON.stringify(event)).not.toMatch(/Private|Person|Bot name|private question/);
  });

  test('a press from someone not on the allow-list gets an alert only they see, and answers nothing', async () => {
    const sessionId = await bindChat(971);
    const id = await pending(sessionId);
    await handleTelegramPress(press(`kq:${id}:0`, { chat: 971, from: '999' }));
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(calls[0]!.body).toMatchObject({ show_alert: true });
    expect(String(calls[0]!.body.text)).toContain('999');
    expect(delivered).toHaveLength(0);
  });

  test('a press on a question from before /new is refused and its buttons are removed', async () => {
    const sessionId = await bindChat(972);
    const id = await pending(sessionId);
    await forgetChatThread({ platform: 'telegram', workspaceId: BOT_ID, threadId: '972', projectId: PROJECT }, 'unused');
    await handleTelegramPress(press(`kq:${id}:0`, { chat: 972 }));
    expect(methods()).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(String(calls[0]!.body.text)).toContain('earlier conversation');
    expect(delivered).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  test("a button that is not a Kortix question's, an unknown question, an option out of range or another chat answers nothing", async () => {
    const sessionId = await bindChat(973);
    const id = await pending(sessionId);
    await handleTelegramPress(press('agent:1', { chat: 973 }));
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(calls[0]!.body).not.toHaveProperty('text');
    for (const data of [`kq:${crypto.randomUUID()}:0`, `kq:${id}:9`]) await handleTelegramPress(press(data, { chat: 973 }));
    await handleTelegramPress(press(`kq:${id}:0`, { chat: 974 }));
    expect(calls.filter((c) => c.method === 'answerCallbackQuery').slice(1).map((c) => String(c.body.text))).toEqual([
      expect.stringContaining('earlier conversation'),
      expect.stringContaining('earlier conversation'),
      expect.stringContaining('earlier conversation'),
    ]);
    expect(delivered).toHaveLength(0);
  });

  test('a press in a forum topic answers into that topic', async () => {
    const sessionId = await newSession();
    await bindChatThread({ projectId: PROJECT, platform: 'telegram', workspaceId: BOT_ID, threadId: '-100975:7', sessionId });
    const id = await pending(sessionId);
    await handleTelegramPress(press(`kq:${id}:0`, { chat: -100975, topic: 7 }));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe(sessionId);
    expect(delivered[0]!.text).toContain('"message_thread_id":7');
  });

  test('a chat that moved on to another session after the check gets no answer delivered', async () => {
    const sessionId = await bindChat(976);
    const id = await pending(sessionId);
    // `/new` and a new message land while the press is being answered.
    onCall = async (call) => {
      if (call.method !== 'editMessageText') return;
      onCall = null;
      await forgetChatThread({ platform: 'telegram', workspaceId: BOT_ID, threadId: '976', projectId: PROJECT }, 'unused');
      await bindChat(976);
    };
    await handleTelegramPress(press(`kq:${id}:0`, { chat: 976 }));
    expect(delivered).toHaveLength(0);
    expect(String(calls.filter((c) => c.method === 'editMessageText').at(-1)!.body.text)).toEndWith(
      'This question is from an earlier conversation. Send your answer as a message.',
    );
  });

  test('a press into a session that is gone drops the chat mapping and starts nothing', async () => {
    const sessionId = await bindChat(977);
    const id = await pending(sessionId);
    deliverResult = 'no-session';
    await handleTelegramPress(press(`kq:${id}:1`, { chat: 977 }));
    expect(delivered).toHaveLength(1);
    expect(created).toHaveLength(0);
    expect(await threadRow(977)).toBeUndefined();
    // Nothing reached an agent: the message must not keep saying "Answered".
    expect(calls.filter((c) => c.method === 'editMessageText').map((c) => String(c.body.text).split('\n').at(-1))).toEqual([
      'Answered: SQLite',
      'This question is from an earlier conversation. Send your answer as a message.',
    ]);
  });

  test('a press into a failed session retries, and on the last attempt tells the chat to start over', async () => {
    const sessionId = await bindChat(978);
    const id = await pending(sessionId);
    deliverResult = 'failed';
    const event = press(`kq:${id}:0`, { chat: 978 });
    await expect(handleTelegramPress(event)).rejects.toThrow('telegram follow-up failed');
    await handleTelegramPress(event, { finalAttempt: true });
    expect(replies().at(-1)).toContain('/new');
  });

  test('a question still blocking its turn is released there with the label, and nothing follows up', async () => {
    releaseOutcome = 'released';
    const sessionId = await bindChat(2010);
    const id = await pending(sessionId, { open: true });
    const [{ requestId }] = await db.select({ requestId: sessionPendingQuestions.requestId }).from(sessionPendingQuestions).where(eq(sessionPendingQuestions.id, id));
    await handleTelegramPress(press(`kq:${id}:1`, { chat: 2010 }));
    expect(releases).toEqual([[sessionId, requestId, [['SQLite']]]]);
    expect(delivered).toHaveLength(0);
    expect(methods()).toEqual(['answerCallbackQuery', 'editMessageText']);
  });

  test('a question the runtime already let go of is answered as a follow-up', async () => {
    releaseOutcome = 'already_answered';
    const sessionId = await bindChat(2011);
    const id = await pending(sessionId, { open: true });
    await handleTelegramPress(press(`kq:${id}:0`, { chat: 2011 }));
    expect(releases).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain('You asked:\n> Which database?\n\nPostgres');
  });

  test('a parked session cannot release in its turn: the press follows up at once, with no retry', async () => {
    const sessionId = await bindChat(2012);
    await db.update(projectSessions).set({ status: 'stopped' }).where(eq(projectSessions.sessionId, sessionId));
    const id = await pending(sessionId, { open: true });
    await handleTelegramPress(press(`kq:${id}:1`, { chat: 2012 }));
    expect(delivered).toHaveLength(1);
  });

  test('a question of another project answers nothing', async () => {
    const otherProject = crypto.randomUUID();
    await db.insert(projects).values({ projectId: otherProject, accountId: ACCOUNT, name: 'telegram-other', repoUrl: 'file:///nonexistent/other.git' });
    const sessionId = await bindChat(2013);
    const [row] = await db
      .insert(sessionPendingQuestions)
      .values({ accountId: ACCOUNT, projectId: otherProject, sessionId, requestId: 'que_other_project', questions: QUESTION, answeredAt: new Date().toISOString() })
      .returning({ id: sessionPendingQuestions.id });
    await handleTelegramPress(press(`kq:${row!.id}:0`, { chat: 2013 }));
    expect(String(calls[0]!.body.text)).toContain('earlier conversation');
    expect(delivered).toHaveLength(0);
    await db.delete(sessionPendingQuestions).where(eq(sessionPendingQuestions.projectId, otherProject));
    await db.delete(projects).where(eq(projects.projectId, otherProject));
  });

  test('a question still blocking its turn is answered there first; an unreachable runtime is retried, then followed up', async () => {
    const sessionId = await bindChat(979);
    await db.update(projectSessions).set({ status: 'running' }).where(eq(projectSessions.sessionId, sessionId));
    const id = await pending(sessionId, { open: true });
    const event = press(`kq:${id}:1`, { chat: 979 });
    // No runtime to release it to here (no sandbox): the job retries instead of
    // queueing the answer behind the turn the question blocks.
    await expect(handleTelegramPress(event)).rejects.toThrow('telegram question release unreachable');
    const [row] = await db.select().from(sessionPendingQuestions).where(eq(sessionPendingQuestions.id, id));
    expect(row!.answeredAt).not.toBeNull();
    expect(row!.answers).toEqual([['SQLite']]);
    expect(delivered).toHaveLength(0);
    // The retry finds its own answer stored and tries the release again.
    await expect(handleTelegramPress(event)).rejects.toThrow('telegram question release unreachable');
    await handleTelegramPress(event, { finalAttempt: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain('You asked:\n> Which database?\n\nSQLite');
  });

  test('a question someone else answered differently is not answered in its turn again: the press follows up', async () => {
    const sessionId = await bindChat(982);
    const id = await pending(sessionId, { open: true });
    await db.update(sessionPendingQuestions).set({ answeredAt: new Date().toISOString(), answers: [['Postgres']] }).where(eq(sessionPendingQuestions.id, id));
    await handleTelegramPress(press(`kq:${id}:1`, { chat: 982 }));
    expect(delivered).toHaveLength(1);
    const [row] = await db.select().from(sessionPendingQuestions).where(eq(sessionPendingQuestions.id, id));
    expect(row!.answers).toEqual([['Postgres']]);
  });

  test('the webhook stores a message and a press, and the job worker runs each through its handler', async () => {
    const sessionId = await bindChat(980);
    const id = await pending(sessionId);
    await db.delete(jobQueue).where(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`));
    const post = (update: Record<string, unknown>) =>
      telegramWebhookApp.request(`/${PROJECT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' },
        body: JSON.stringify(update),
      });
    const message = update('typed answer', ALLOWED, 980);
    expect((await post({ update_id: Number(message.id), message: message.data.message })).status).toBe(200);
    const tap = press(`kq:${id}:0`, { chat: 980 });
    expect((await post({ update_id: Number(tap.id), callback_query: { ...(tap.data.callback_query as object), from: { id: Number(ALLOWED), first_name: 'Private Name' } } })).status).toBe(200);
    const stored = await db.select().from(jobQueue).where(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`));
    expect(stored.map((j) => j.queue)).toEqual([INTEGRATION_EVENTS_QUEUE, INTEGRATION_EVENTS_QUEUE]);
    expect(JSON.stringify(stored.map((j) => j.payload))).not.toContain('Private Name');

    await runJobBatch();
    const settled = await db.select({ status: jobQueue.status }).from(jobQueue).where(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`));
    expect(settled.map((j) => j.status)).toEqual(['done', 'done']);
    expect(delivered.map((d) => d.sessionId)).toEqual([sessionId, sessionId]);
    expect(methods()).toContain('answerCallbackQuery');
  });
});

describe('Telegram allowed users and access requests — migrated PostgreSQL', () => {
  registerChannelTelegramRoutes();
  const ADMIN = crypto.randomUUID();
  const api = async (method: string, path: string, body?: unknown, userId = ADMIN) => {
    const app = new Hono<{ Variables: Record<string, unknown> }>();
    app.use('*', async (c, next) => {
      c.set('userId', userId);
      c.set('authType', 'jwt');
      await next();
    });
    app.route('/v1/projects', projectsApp);
    return app.request(`/v1/projects/${PROJECT}/channels/telegram${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  };
  const telegramMetadata = async () => {
    const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
    return (row!.metadata as { telegram?: Record<string, any> } | null)?.telegram ?? {};
  };
  const setTelegram = (telegram: Record<string, unknown>) =>
    db.update(projects).set({ metadata: { telegram } }).where(eq(projects.projectId, PROJECT));
  const request = (id: string, last_seen = new Date().toISOString()) => ({
    id,
    username: `user_${id}`,
    first_name: `Stored ${id}`,
    last_name: null,
    last_seen,
  });
  /** A message to the bot from `from`, in a private chat with them unless `chat` says otherwise. */
  const message = (text: string, from: Record<string, unknown>, chat: { id: number; type: string } = { id: Number(from.id), type: 'private' }) =>
    telegramMessageEvent(PROJECT, BOT_ID, {
      update_id: updateId++,
      message: { message_id: updateId, date: 1_760_000_000, chat, from: from as TelegramMessage['from'], text },
    })!;

  beforeAll(async () => {
    await insertIntoView(db, accountMembers, { userId: ADMIN, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
  });
  afterEach(allowSender);

  test('a not-allowed sender in a private chat is recorded once, with the id and names only; a repeat within the hour writes nothing', async () => {
    const from = { id: 4001, is_bot: false, username: 'synthetic_requester', first_name: 'Synthetic', last_name: 'Requester', language_code: 'en' };
    await handleTelegramEvent(message('please run the secret plan', from));
    const [entry] = (await telegramMetadata()).accessRequests;
    expect(Object.keys(entry).sort()).toEqual(['first_name', 'id', 'last_name', 'last_seen', 'username']);
    expect(entry).toMatchObject({ id: '4001', username: 'synthetic_requester', first_name: 'Synthetic', last_name: 'Requester' });
    expect(JSON.stringify(await telegramMetadata())).not.toContain('secret plan');
    expect(replies()).toEqual([expect.stringContaining('Customize → Connectors → Channels → Telegram')]);
    expect(replies()[0]).toContain('4001');
    // The pairing reply is the only Telegram call: recording asks Telegram nothing.
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);

    await handleTelegramEvent(message('again', from));
    expect((await telegramMetadata()).accessRequests).toEqual([entry]);
    await handleTelegramEvent(message('renamed', { ...from, first_name: 'Renamed' }));
    expect((await telegramMetadata()).accessRequests).toEqual([expect.objectContaining({ id: '4001', first_name: 'Renamed' })]);
  });

  test('an allowed sender and a sender in a group are not recorded', async () => {
    await handleTelegramEvent(message('/start', { id: Number(ALLOWED), first_name: 'Allowed' }));
    await handleTelegramEvent(message('hello', { id: 4002, first_name: 'Group Member' }, { id: -4100, type: 'group' }));
    expect((await telegramMetadata()).accessRequests).toBeUndefined();
    expect(replies()[1]).toContain('message this bot privately');
  });

  test('concurrent requests all land, newest first, and the list keeps the newest 20', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => recordTelegramAccessRequest(PROJECT, { id: 4050 + i })));
    expect((await telegramMetadata()).accessRequests.map((r: { id: string }) => r.id).sort()).toEqual(['4050', '4051', '4052', '4053', '4054']);
    for (let i = 0; i < 20; i++) await recordTelegramAccessRequest(PROJECT, { id: 4060 + i });
    const ids = (await telegramMetadata()).accessRequests.map((r: { id: string }) => r.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('4079');
  });

  test('a stored name loses its control characters and is cut at 64 characters, never inside an emoji', async () => {
    await recordTelegramAccessRequest(PROJECT, { id: 4085, first_name: `a${'🙂'.repeat(70)}`, last_name: 'Syn\u0000thetic', username: 42 });
    expect((await telegramMetadata()).accessRequests[0]).toMatchObject({
      id: '4085',
      first_name: `a${'🙂'.repeat(63)}`,
      last_name: 'Synthetic',
      username: null,
    });
  });

  test('the list names allowed users and requests from Telegram and falls back when getChat fails', async () => {
    chats.set('4010', { first_name: 'Ada', username: 'ada_synthetic', photo: { small_file_id: 'f4010', small_file_unique_id: 'u4010' } });
    chats.set('4012', 'fail');
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    // 4011 is a legacy numeric id; 4013 asked over 30 days ago; 4010 asked and is allowed.
    await setTelegram({ allowedUserIds: ['4010', 4011], accessRequests: [request('4012'), request('4013', old), request('4010')] });

    const res = await api('GET', '/users');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toEqual([
      { user_id: '4010', username: 'ada_synthetic', first_name: 'Ada', last_name: null, photo_version: 'u4010', known: true },
      { user_id: '4011', username: null, first_name: null, last_name: null, photo_version: null, known: false },
    ]);
    expect(body.requests).toEqual([
      { user_id: '4012', username: 'user_4012', first_name: 'Stored 4012', last_name: null, photo_version: null, known: true, last_seen: expect.any(String) },
    ]);
    const install = await (await api('GET', '/installation')).json();
    expect(install).toMatchObject({ allowed_user_ids: ['4010', '4011'], access_request_count: 1 });
  });

  test('the photo route serves the bytes through the API, never the token; an id not listed is 404', async () => {
    chats.set('4015', { first_name: 'Photo', photo: { small_file_id: 'f4015', small_file_unique_id: 'u4015' } });
    await setTelegram({ allowedUserIds: ['4015', '4016'] });
    downloads.length = 0;

    const res = await api('GET', '/users/4015/photo?v=u4015');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(JPEG);
    expect(JSON.stringify([...res.headers]) + new TextDecoder().decode(bytes)).not.toContain(TOKEN);
    expect(downloads).toEqual([`/file/bot${TOKEN}/photos/f4015.jpg`]);

    const unknown = await api('GET', '/users/4999/photo');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'telegram_user_unknown' });
    // 4016 never started the bot: getChat answers "chat not found".
    expect(await (await api('GET', '/users/4016/photo')).json()).toMatchObject({ code: 'telegram_photo_unavailable' });
    failing = 'getFile';
    const down = await api('GET', '/users/4015/photo');
    expect(down.status).toBe(502);
    const text = await down.text();
    expect(text).toContain('telegram_unreachable');
    expect(text).not.toContain(TOKEN);
  });

  test('allow moves a request to the allowed list in one write; a legacy numeric id is not added twice; a full list is 409', async () => {
    await setTelegram({ allowedUserIds: [4021], accessRequests: [request('4020'), request('4022')] });
    const allowed = await api('POST', '/allowed-users', { user_id: '4020' });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ allowed_user_ids: ['4021', '4020'], access_request_count: 1 });
    expect((await telegramMetadata()).accessRequests.map((r: { id: string }) => r.id)).toEqual(['4022']);

    const again = await api('POST', '/allowed-users', { user_id: '4021' });
    expect(await again.json()).toMatchObject({ allowed_user_ids: ['4021', '4020'] });
    expect(await (await api('POST', '/allowed-users', { user_id: '@someone' })).json()).toMatchObject({ code: 'telegram_user_ids_invalid' });

    await setTelegram({ allowedUserIds: Array.from({ length: 200 }, (_, i) => String(10_000 + i)) });
    const full = await api('POST', '/allowed-users', { user_id: '4023' });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'telegram_allowed_users_full' });
  });

  test('remove and dismiss are idempotent and answer the installation', async () => {
    await setTelegram({ allowedUserIds: ['4030', '4031'], accessRequests: [request('4032')] });
    for (let i = 0; i < 2; i++) {
      const removed = await api('DELETE', '/allowed-users/4030');
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ allowed_user_ids: ['4031'] });
      const dismissed = await api('DELETE', '/access-requests/4032');
      expect(dismissed.status).toBe(200);
      expect(await dismissed.json()).toMatchObject({ access_request_count: 0 });
    }
    expect((await api('DELETE', '/allowed-users/abc')).status).toBe(400);
  });

  test('a non-member reads no identities and changes nothing', async () => {
    await setTelegram({ allowedUserIds: ['4040'], accessRequests: [request('4041')] });
    const stranger = crypto.randomUUID();
    expect([403, 404]).toContain((await api('GET', '/users', undefined, stranger)).status);
    expect([403, 404]).toContain((await api('GET', '/users/4040/photo', undefined, stranger)).status);
    expect([403, 404]).toContain((await api('POST', '/allowed-users', { user_id: '4041' }, stranger)).status);
    expect((await telegramMetadata()).allowedUserIds).toEqual(['4040']);
  });

  test('the public project shape hides metadata.telegram', async () => {
    await setTelegram({ allowedUserIds: ['4040'], accessRequests: [request('4041')] });
    const [row] = await db.select().from(projects).where(eq(projects.projectId, PROJECT));
    expect((row!.metadata as Record<string, unknown>).telegram).toBeDefined();
    expect(serializeProject(row!).metadata).not.toHaveProperty('telegram');
  });

  test('disconnect clears the requests and keeps the allowed list for a reconnect', async () => {
    await setTelegram({ allowedUserIds: ['4040'], accessRequests: [request('4041')] });
    await deleteTelegramInstall(PROJECT);
    expect(await telegramMetadata()).toEqual({ allowedUserIds: ['4040'] });
    await saveTelegramInstall({ projectId: PROJECT, botId: BOT_ID, username: 'synthetic_bot', token: TOKEN, webhookSecret: 's' });
  });
});
