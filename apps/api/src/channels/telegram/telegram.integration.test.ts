/**
 * Real-Postgres contract for Telegram as a channel connector (connectors_v2):
 * the inbox stores an update once, an unknown sender gets a pairing reply and
 * no session, an allowed sender in a new chat starts one session bound to the
 * chat, the next message follows up into it, `/new` forgets it, and with the
 * flag off nothing runs. Telegram is a local fake; the session lifecycle is a
 * recorder, so no sandbox is needed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, chatEventDedup, chatThreads, jobQueue, projectSessions, projects } from '@kortix/db';
import { and, eq, like } from 'drizzle-orm';
import { config } from '../../config';
import { emitIntegrationEvent, INTEGRATION_EVENTS_QUEUE } from '../../integrations/event-inbox';
import { db } from '../../shared/db';
import { deleteTelegramInstall, saveTelegramInstall, setTelegramAllowedUserIds } from './installs';
import {
  handleTelegramEvent,
  resetTelegramLifecycleForTest,
  setTelegramLifecycleForTest,
  telegramMessageEvent,
  type TelegramMessage,
} from './session';

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
const delivered: Array<Record<string, any>> = [];
let createResult: Record<string, unknown> = {};
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

async function setFlag(on: boolean) {
  await db
    .update(projects)
    .set({ metadata: { experimental: { connectors_v2: on }, telegram: { allowedUserIds: [ALLOWED] } } })
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
  await setFlag(true);
  setTelegramLifecycleForTest({
    resolveProjectAutomationActor: async () => ACTOR,
    createSession: (async (input: Record<string, any>) => {
      created.push(input);
      return createResult;
    }) as never,
    deliverThroughQueue: (async (command: Record<string, any>) => {
      delivered.push(command);
      return 'queued';
    }) as never,
  });
});

beforeEach(() => {
  calls.length = 0;
  created.length = 0;
  delivered.length = 0;
  createResult = {};
});

afterAll(async () => {
  resetTelegramLifecycleForTest();
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

  test('an allowed sender in a new chat starts one project-visible session bound to the chat', async () => {
    await handleTelegramEvent(update('summarize the release'));
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction']);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: 'telegram',
      visibility: 'project',
      userId: ACTOR,
      metadata: { source: 'telegram', telegram: { bot_id: BOT_ID, chat_id: 777 } },
      postCreate: [
        { type: 'bind_chat_thread', platform: 'telegram', workspaceId: BOT_ID, threadId: '777' },
        { type: 'deliver_prompt', source: 'telegram' },
      ],
    });
    expect(created[0]!.postCreate[1].text).toContain('kortix_telegram.send_message');
  });

  test('the next message in a bound chat follows up into its session; /new forgets the chat', async () => {
    const sessionId = crypto.randomUUID();
    await db.insert(projectSessions).values({ sessionId, accountId: ACCOUNT, projectId: PROJECT, branchName: sessionId, createdBy: ACTOR });
    await db.insert(chatThreads).values({ projectId: PROJECT, platform: 'telegram', workspaceId: BOT_ID, threadId: '888', sessionId });
    await handleTelegramEvent(update('and the risks?', ALLOWED, 888));
    expect(created).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ source: 'telegram', sessionId, projectId: PROJECT });

    await handleTelegramEvent(update('/new', ALLOWED, 888));
    const [thread] = await db.select().from(chatThreads).where(and(eq(chatThreads.workspaceId, BOT_ID), eq(chatThreads.threadId, '888')));
    expect(thread).toBeUndefined();
    expect(calls.at(-1)?.method).toBe('sendMessage');
  });

  test('a create the lifecycle requeued keeps the chat claimed; a final failure says why and frees it', async () => {
    const claim = (chat: number) =>
      db.select().from(chatEventDedup).where(eq(chatEventDedup.eventId, `telegram:threadcreate:${PROJECT}:${BOT_ID}:${chat}`));

    createResult = { status: 'failed', retryable: true, requeued: true, error: { status: 503, body: { error: 'clone failed' } } };
    await handleTelegramEvent(update('first try', ALLOWED, 901));
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(String(calls[1]!.body.text)).toContain('still starting a session');
    expect(await claim(901)).toHaveLength(1);

    calls.length = 0;
    createResult = { status: 'failed', retryable: false, error: { status: 402, body: { error: 'no credits' } } };
    await handleTelegramEvent(update('second try', ALLOWED, 902));
    expect(String(calls.at(-1)!.body.text)).toContain('out of credits');
    expect(await claim(902)).toHaveLength(0);
  });

  test('a chat whose first session is still starting: retry, and on the last attempt say so', async () => {
    await db.insert(chatEventDedup).values({
      eventId: `telegram:threadcreate:${PROJECT}:${BOT_ID}:903`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const event = update('are you there?', ALLOWED, 903);
    await handleTelegramEvent(event, { finalAttempt: true });
    expect(created).toHaveLength(0);
    expect(calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(String(calls[1]!.body.text)).toContain('Send your message again');
  }, 20_000);

  test('with connectors_v2 off the consumer does nothing', async () => {
    await setFlag(false);
    try {
      await handleTelegramEvent(update('hello again', ALLOWED, 999));
      expect(calls).toHaveLength(0);
      expect(created).toHaveLength(0);
    } finally {
      await setFlag(true);
    }
  });

  test('allowed users are replaced, not merged', async () => {
    await setTelegramAllowedUserIds(PROJECT, ['5', '6']);
    const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
    expect((row!.metadata as any).telegram.allowedUserIds).toEqual(['5', '6']);
    expect((row!.metadata as any).experimental.connectors_v2).toBe(true);
    await setFlag(true);
  });
});
