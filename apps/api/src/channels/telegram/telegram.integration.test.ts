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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, chatEventDedup, chatThreads, jobQueue, projectSessions, projects } from '@kortix/db';
import { and, eq, like } from 'drizzle-orm';
import { config } from '../../config';
import { emitIntegrationEvent, INTEGRATION_EVENTS_QUEUE } from '../../integrations/event-inbox';
import { connectorConnectionIsConnected } from '../../projects/lib/session-connector-bindings';
import { db } from '../../shared/db';
import { resetChannelLifecycleForTest, setChannelLifecycleForTest } from '../core/conversation';
import { bindChatThread } from '../core/threads';
import { deleteTelegramInstall, saveTelegramInstall, setTelegramAllowedUserIds } from './installs';
import { handleTelegramEvent, telegramMessageEvent, type TelegramMessage } from './session';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ACTOR = crypto.randomUUID();
const BOT_ID = String(5_000_000_000 + Math.floor(Math.random() * 1_000_000));
const TOKEN = `${BOT_ID}:${'A'.repeat(35)}`;
const ALLOWED = '111';

const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const [, botToken, method] = new URL(req.url).pathname.split('/');
    if (botToken !== `bot${TOKEN}`) return Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 });
    calls.push({ method: method ?? '', body: (await req.json().catch(() => ({}))) as Record<string, unknown> });
    return Response.json({ ok: true, result: { message_id: 1 } });
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
    repoUrl: 'https://example.test/t.git',
  });
  await saveTelegramInstall({ projectId: PROJECT, botId: BOT_ID, username: 'synthetic_bot', token: TOKEN, webhookSecret: 's' });
  await allowSender();
  restoreLifecycle();
});

function restoreLifecycle() {
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
  sleeps = 0;
});

afterAll(async () => {
  resetChannelLifecycleForTest();
  fake.stop(true);
  await db.delete(chatThreads).where(eq(chatThreads.workspaceId, BOT_ID));
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `telegram:threadcreate:${PROJECT}:%`));
  await db.delete(jobQueue).where(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`));
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
        { type: 'bind_chat_thread', platform: 'telegram', workspaceId: BOT_ID, threadId: '777' },
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

  test('a message whose racing create bound the chat and freed its claim follows up instead of creating', async () => {
    // Between this message's lookup and its claim, another message's create
    // bound the chat and released its claim (the actor lookup runs in between).
    let winner = '';
    setChannelLifecycleForTest({
      resolveProjectAutomationActor: async () => {
        winner = await bindChat(919);
        return ACTOR;
      },
      createSession: (async (input: Record<string, any>) => {
        created.push(input);
        return { status: 'created', sessionId: crypto.randomUUID() };
      }) as never,
      deliverThroughQueue: (async (command: Record<string, any>) => {
        delivered.push(command);
        return deliverResult;
      }) as never,
      sleep: async () => {
        sleeps++;
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
