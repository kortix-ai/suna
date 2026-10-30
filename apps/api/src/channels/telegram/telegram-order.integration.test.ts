/**
 * Real-Postgres contract: one Telegram chat's updates reach its session in
 * Telegram's update order, one at a time, even when the webhook stores them out
 * of order and the job worker has free slots. Another chat never waits, and an
 * earlier update that died holds its chat only until its claim expires, once.
 *
 * Intake is the real webhook route; the job worker is the real one. The
 * session lifecycle is cut at the network: the hand-off records its order and
 * inserts the same `continue_session` row `deliverThroughQueue` inserts, with
 * no drain and no sandbox. Telegram is a local fake. No real-time sleep.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, chatEventDedup, chatThreads, jobQueue, projectSessions, projects, sessionLifecycleCommands } from '@kortix/db';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import { config } from '../../config';
import { INTEGRATION_EVENTS_QUEUE } from '../../integrations/event-inbox';
import { enqueueContinueSessionCommand } from '../../projects/session-lifecycle/enqueue-commands';
import { db } from '../../shared/db';
import { claimJobs, runJobBatch } from '../../shared/job-queue';
import { resetChannelLifecycleForTest, setChannelLifecycleForTest } from '../core/conversation';
import { bindChatThread } from '../core/threads';
import { channelWebhookRoutes } from '../inbound/webhook-routes';
import { telegramInbound } from './inbound';
import { deleteTelegramInstall, saveTelegramInstall } from './installs';
import { telegramMenuClaim } from './menu';

const webhook = channelWebhookRoutes(telegramInbound);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const ACTOR = crypto.randomUUID();
const BOT_ID = String(5_000_000_000 + Math.floor(Math.random() * 1_000_000));
const TOKEN = `${BOT_ID}:${'A'.repeat(35)}`;
const ALLOWED = 111;

/** What happened, in order: `deliver:<key>` for a hand-off to the session, `api:<method>` for a Bot API call. */
const timeline: string[] = [];
const fake = Bun.serve({
  port: 0,
  fetch(req) {
    timeline.push(`api:${new URL(req.url).pathname.split('/')[2]}`);
    return Response.json({ ok: true, result: { message_id: 1 } });
  },
});
const delivered = () => timeline.filter((t) => t.startsWith('deliver:')).map((t) => t.slice('deliver:'.length));

/** The hand-off of this key waits until `openGate()`. */
let gatedKey: string | null = null;
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
function holdAt(key: string) {
  gatedKey = key;
  gate = new Promise<void>((resolve) => (openGate = resolve));
}

/**
 * A worker tick that returns once its jobs started (`start`), a promise per settle count (`reached`), and
 * `settleAll` for every job the ticks started, so a failed test leaves no job running into the next.
 */
function ticks() {
  let count = 0;
  let started = 0;
  const waiting: Array<{ at: number; resolve: () => void }> = [];
  const onSlotFree = () => {
    count++;
    for (const w of waiting.filter((w) => w.at <= count)) w.resolve();
  };
  const reached = (at: number) => new Promise<void>((resolve) => (count >= at ? resolve() : waiting.push({ at, resolve })));
  return {
    start: async () => {
      const n = await runJobBatch(4, { wait: false, onSlotFree });
      started += n;
      return n;
    },
    reached,
    settleAll: () => {
      openGate();
      return reached(started);
    },
  };
}

let nextUpdateId = 900_000;
const key = (updateId: number) => `telegram:${BOT_ID}:${updateId}`;
const ids = (n: number) => Array.from({ length: n }, () => nextUpdateId++);

async function post(update: Record<string, unknown>) {
  const res = await webhook.request(`/${PROJECT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' },
    body: JSON.stringify(update),
  });
  expect(res.status).toBe(200);
}

const topicOf = (topic?: number) => (topic ? { message_thread_id: topic, is_topic_message: true } : {});
const chatOf = (chat: number, topic?: number) => ({ id: chat, type: topic ? 'supergroup' : 'private' });

function sendMessage(chat: number, updateId: number, topic?: number) {
  return post({
    update_id: updateId,
    message: { message_id: updateId, date: 1_760_000_000, chat: chatOf(chat, topic), from: { id: ALLOWED, username: 'synthetic' }, text: `m${updateId}`, ...topicOf(topic) },
  });
}

/** A press on a menu Kortix never sent: its handler only answers that the menu is out of date. */
function sendPress(chat: number, updateId: number, topic?: number) {
  return post({
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: ALLOWED, first_name: 'Synthetic' },
      data: 'kc:status',
      message: { message_id: 50, date: 1_760_000_000, chat: chatOf(chat, topic), ...topicOf(topic) },
    },
  });
}

async function bindChat(threadId: string) {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({ sessionId, accountId: ACCOUNT, projectId: PROJECT, branchName: sessionId, createdBy: ACTOR });
  await bindChatThread({ projectId: PROJECT, platform: 'telegram', workspaceId: BOT_ID, threadId, sessionId });
  return sessionId;
}

const jobRows = (updateIds: number[]) =>
  db.select().from(jobQueue).where(inArray(jobQueue.jobKey, updateIds.map(key))).orderBy(asc(jobQueue.jobKey));
const jobStates = async (updateIds: number[]) => (await jobRows(updateIds)).map((r) => `${r.status}/${r.attempts}`);

/** The `continue_session` keys of a session, in the order the rows were created. */
async function sessionRows(sessionId: string) {
  const rows = await db
    .select({ key: sessionLifecycleCommands.idempotencyKey })
    .from(sessionLifecycleCommands)
    .where(and(eq(sessionLifecycleCommands.sessionId, sessionId), eq(sessionLifecycleCommands.commandType, 'continue_session')))
    .orderBy(asc(sessionLifecycleCommands.createdAt));
  return rows.map((r) => r.key);
}

/** Run the worker until no update of this bot is queued. */
async function drain() {
  for (let pass = 0; pass < 12; pass++) {
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobQueue)
      .where(and(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`), eq(jobQueue.status, 'queued')));
    if (left!.n === 0) return;
    await runJobBatch();
  }
  throw new Error('updates still queued after 12 worker passes');
}

beforeAll(async () => {
  (config as { TELEGRAM_API_URL: string }).TELEGRAM_API_URL = fake.url.origin;
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'telegram-order-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'telegram-order',
    repoUrl: 'file:///nonexistent/telegram-order.git',
    metadata: { telegram: { allowedUserIds: [String(ALLOWED)] } },
  });
  await saveTelegramInstall({ projectId: PROJECT, botId: BOT_ID, username: 'synthetic_bot', token: TOKEN, webhookSecret: 's' });
  // The bot's menu already merged and it already receives presses: no update below calls the menu methods.
  const day = new Date(Date.now() + 86_400_000);
  await db.insert(chatEventDedup).values([
    { eventId: telegramMenuClaim(BOT_ID), expiresAt: day },
    { eventId: `telegram:buttons:${BOT_ID}`, expiresAt: day },
  ]);
  setChannelLifecycleForTest({
    resolveProjectAutomationActor: async () => ACTOR,
    sleep: async () => {},
    deliverThroughQueue: (async (c: Record<string, any>) => {
      if (c.idempotencyKey === gatedKey) await gate;
      timeline.push(`deliver:${c.idempotencyKey}`);
      // The row deliverThroughQueue inserts (follow-up-delivery.ts); no drain, no sandbox.
      await enqueueContinueSessionCommand({
        source: 'telegram',
        projectId: PROJECT,
        accountId: ACCOUNT,
        sessionId: c.sessionId,
        actorUserId: ACTOR,
        text: c.text,
        idempotencyKey: c.idempotencyKey,
        directFollowUp: true,
      });
      return 'queued';
    }) as never,
  });
});

beforeEach(async () => {
  timeline.length = 0;
  gatedKey = null;
  await db.delete(jobQueue).where(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`));
});

afterAll(async () => {
  resetChannelLifecycleForTest();
  fake.stop(true);
  await db.delete(jobQueue).where(like(jobQueue.jobKey, `telegram:${BOT_ID}:%`));
  await db.delete(chatThreads).where(eq(chatThreads.workspaceId, BOT_ID));
  await db.delete(chatEventDedup).where(inArray(chatEventDedup.eventId, [telegramMenuClaim(BOT_ID), `telegram:buttons:${BOT_ID}`]));
  await deleteTelegramInstall(PROJECT);
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('Telegram update order — migrated PostgreSQL', () => {
  test('six updates of one chat, stored out of order, reach the session in update order', async () => {
    const sessionId = await bindChat('7001');
    const u = ids(6);
    // Telegram's parallel webhook connections store them in another order.
    for (const i of [2, 0, 1, 5, 3, 4]) await sendMessage(7001, u[i]!);
    holdAt(key(u[0]!));
    const tick = ticks();
    try {
      // Only the lowest update runs, though the replica has 3 slots for the queue.
      expect(await tick.start()).toBe(1);
      // The later ones stay held while it runs.
      expect(await tick.start()).toBe(0);
      expect(delivered()).toEqual([]);
    } finally {
      await tick.settleAll();
    }
    await drain();

    expect(delivered()).toEqual(u.map(key));
    expect(await sessionRows(sessionId)).toEqual(u.map(key));
    const rows = await jobRows(u);
    expect(rows.map((r) => `${r.status}/${r.attempts}`)).toEqual(u.map(() => 'done/1'));
    expect(rows.map((r) => (r.payload as { sequence?: number }).sequence)).toEqual(u);
  });

  test('a message whose replica died holds its chat until its claim expires, re-runs first, and a second death frees the chat', async () => {
    const sessionId = await bindChat('7002');
    const [a, b, c] = ids(3) as [number, number, number];
    for (const id of [a, b, c]) await sendMessage(7002, id);
    // A replica claims the first update and dies: its claim never settles.
    const [claimed] = await claimJobs([INTEGRATION_EVENTS_QUEUE], 1, 120_000);
    expect(claimed!.jobKey).toBe(key(a));
    await runJobBatch();
    expect(delivered()).toEqual([]);
    // The claim expires (the fake clock): the dead run is claimed again first, and the chat follows in order.
    await db.update(jobQueue).set({ lockedUntil: sql`now() - interval '1 second'` }).where(eq(jobQueue.jobKey, key(a)));
    await drain();
    expect(delivered()).toEqual([a, b, c].map(key));
    expect(await sessionRows(sessionId)).toEqual([a, b, c].map(key));
    expect(await jobStates([a, b, c])).toEqual(['done/2', 'done/1', 'done/1']);

    // A second death frees the chat: the next update no longer waits for it.
    timeline.length = 0;
    await bindChat('7003');
    const [d, e] = ids(2) as [number, number];
    for (const id of [d, e]) await sendMessage(7003, id);
    for (let death = 0; death < 2; death++) {
      const [dead] = await claimJobs([INTEGRATION_EVENTS_QUEUE], 1, 120_000);
      expect(dead!.jobKey).toBe(key(d));
      await db.update(jobQueue).set({ lockedUntil: sql`now() - interval '1 second'` }).where(eq(jobQueue.jobKey, key(d)));
    }
    expect(await runJobBatch()).toBe(2);
    expect(delivered().sort()).toEqual([d, e].map(key).sort());
    expect(await jobStates([d, e])).toEqual(['done/3', 'done/1']);
  });

  test("another chat's message runs while a chat waits on its first", async () => {
    await bindChat('7004');
    await bindChat('7005');
    const [a1, a2, b1] = ids(3) as [number, number, number];
    await sendMessage(7004, a1);
    await sendMessage(7004, a2);
    await sendMessage(7005, b1);
    holdAt(key(a1));
    const tick = ticks();
    try {
      expect(await tick.start()).toBe(2);
      await tick.reached(1);
      // B's message went through while A's first still waits; A's second was never claimed.
      expect(delivered()).toEqual([key(b1)]);
      expect(await jobStates([a2])).toEqual(['queued/0']);
    } finally {
      await tick.settleAll();
    }
    await drain();
    expect(delivered()).toEqual([b1, a1, a2].map(key));
  });

  test('a button press waits for the message sent before it in the same forum topic', async () => {
    await bindChat('7006:9');
    const [m, p] = ids(2) as [number, number];
    await sendMessage(7006, m, 9);
    await sendPress(7006, p, 9);
    const payloads = (await jobRows([m, p])).map((r) => r.payload as { subject: string; sequence?: number });
    expect(payloads.map((x) => [x.subject, x.sequence])).toEqual([
      ['7006:9', m],
      ['7006:9', p],
    ]);
    holdAt(key(m));
    const tick = ticks();
    try {
      expect(await tick.start()).toBe(1);
      expect(timeline).not.toContain('api:answerCallbackQuery');
    } finally {
      await tick.settleAll();
    }
    await drain();
    const handOff = timeline.indexOf(`deliver:${key(m)}`);
    const answer = timeline.indexOf('api:answerCallbackQuery');
    expect(handOff).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(handOff);
  });
});
