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
import { accounts, chatEventDedup, chatThreads, jobQueue, projectSessions, projects, sessionLifecycleCommands, sessionPendingQuestions } from '@kortix/db';
import { and, eq, like } from 'drizzle-orm';
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
import { deleteTelegramInstall, saveTelegramInstall, setTelegramAllowedUserIds } from './installs';
import { handleTelegramEvent, handleTelegramPress, telegramMessageEvent, telegramPressEvent, type TelegramMessage } from './session';
import { telegramWebhookApp } from '../telegram-webhook';
import { runJobBatch } from '../../shared/job-queue';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ACTOR = crypto.randomUUID();
const BOT_ID = String(5_000_000_000 + Math.floor(Math.random() * 1_000_000));
const TOKEN = `${BOT_ID}:${'A'.repeat(35)}`;
const ALLOWED = '111';

type Call = { method: string; body: Record<string, unknown> };
const calls: Call[] = [];
const waiters: Array<(call: Call) => void> = [];
/** The next Bot API call, for a send nothing awaits (the provisioning notifier fires and forgets). */
const nextCall = () => new Promise<Call>((resolve) => waiters.push(resolve));
/** Runs inside a Bot API call, before it answers: a test changes state mid-press. */
let onCall: ((call: Call) => Promise<void>) | null = null;
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const [, botToken, method] = new URL(req.url).pathname.split('/');
    if (botToken !== `bot${TOKEN}`) return Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 });
    const call = { method: method ?? '', body: (await req.json().catch(() => ({}))) as Record<string, unknown> };
    calls.push(call);
    await onCall?.(call);
    waiters.splice(0).forEach((resolve) => resolve(call));
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
    repoUrl: 'https://example.test/t.git',
  });
  await saveTelegramInstall({ projectId: PROJECT, botId: BOT_ID, username: 'synthetic_bot', token: TOKEN, webhookSecret: 's' });
  await allowSender();
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

describe('Telegram question buttons — migrated PostgreSQL', () => {
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
    const event = press('kq:00000000-0000-0000-0000-000000000000:0');
    expect(event).toMatchObject({ type: 'telegram.callback_query.created', source: `telegram:${BOT_ID}`, subject: '777' });
    expect(Object.keys(event.data)).toEqual(['callback_query']);
    expect(Object.keys(event.data.callback_query as object).sort()).toEqual(['data', 'from', 'id', 'message']);
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
      await forgetChatThread({ platform: 'telegram', workspaceId: BOT_ID, threadId: '976', projectId: PROJECT }, 'unused');
      await bindChat(976);
    };
    await handleTelegramPress(press(`kq:${id}:0`, { chat: 976 }));
    expect(delivered).toHaveLength(0);
  });

  test('a press into a session that is gone drops the chat mapping and starts nothing', async () => {
    const sessionId = await bindChat(977);
    const id = await pending(sessionId);
    deliverResult = 'no-session';
    await handleTelegramPress(press(`kq:${id}:1`, { chat: 977 }));
    expect(delivered).toHaveLength(1);
    expect(created).toHaveLength(0);
    expect(await threadRow(977)).toBeUndefined();
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

  test('a question still blocking its turn is answered there first: the press closes it with the label', async () => {
    const sessionId = await bindChat(979);
    const id = await pending(sessionId, { open: true });
    await handleTelegramPress(press(`kq:${id}:1`, { chat: 979 }));
    const [row] = await db.select().from(sessionPendingQuestions).where(eq(sessionPendingQuestions.id, id));
    expect(row!.answeredAt).not.toBeNull();
    expect(row!.answers).toEqual([['SQLite']]);
    // No runtime to release it to here (no sandbox): the answer follows up instead.
    expect(delivered).toHaveLength(1);
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
