/**
 * Real-Postgres parity table for the Telegram webhook,
 * `POST /v1/webhooks/telegram/{projectId}`. Each case pins what the route
 * answers today: the status, the body, the global handler's error line, and
 * the inbox rows as (queue, job_key, max_attempts). A change to the route
 * keeps every row of this table.
 *
 * The route is mounted as app.ts mounts it: under a parent app whose onError
 * is the global one (installHttpErrors), so a throw answers the global 500.
 * A store failure is a BEFORE INSERT trigger on kortix.job_queue: it refuses
 * update FAILING_UPDATE, which only this suite sends.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accounts, jobQueue, projects } from '@kortix/db';
import { asc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { installHttpErrors } from '../../http-errors';
import { logger } from '../../lib/logger';
import { runWithContext } from '../../lib/request-context';
import { makeOpenApiApp } from '../../openapi';
import { type AuditPrincipal, attachInboundAuditScope } from '../../shared/audit-scope';
import { db } from '../../shared/db';
import { channelWebhookRoutes } from '../inbound/webhook-routes';
import { telegramInbound } from './inbound';
import { deleteTelegramInstall, saveTelegramInstall } from './installs';

const ACCOUNT = crypto.randomUUID();
const LIVE = crypto.randomUUID();
const TOMBSTONE = crypto.randomUUID();
/** A project with no Telegram install and no webhook secret. */
const UNKNOWN = crypto.randomUUID();
const newBotId = () => String(5_000_000_000 + Math.floor(Math.random() * 1_000_000));
const BOT = newBotId();
const TOMBSTONE_BOT = newBotId();
const SECRET = 'parity-secret';
const FAILING_UPDATE = 9999;

const app = makeOpenApiApp();
app.route('/v1/webhooks/telegram', channelWebhookRoutes(telegramInbound));
installHttpErrors(app);

const SIGNED = { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET };
const DATE = 1_760_000_000;
const message = (updateId: number, from: Record<string, unknown> = { id: 111, username: 'synthetic' }) =>
  JSON.stringify({
    update_id: updateId,
    message: { message_id: updateId, date: DATE, chat: { id: 777, type: 'private' }, from, text: 'hello' },
  });
const press = (updateId: number) =>
  JSON.stringify({
    update_id: updateId,
    callback_query: {
      id: 'cbq-parity',
      from: { id: 111, username: 'synthetic', first_name: 'Private', last_name: 'Name' },
      data: 'kq:parity:0',
      message: { message_id: 50, date: DATE, chat: { id: 777, type: 'private', title: 'Private Title' }, text: 'Question text' },
    },
  });

const GLOBAL_500 = { error: true, message: 'Internal server error', status: 500 };
/** A photo with no caption, in two sizes: only file ids, as Telegram sends it. */
const PHOTO = {
  message_id: 1006,
  date: DATE,
  chat: { id: 777, type: 'private' },
  from: { id: 111, username: 'synthetic' },
  photo: [
    { file_id: 'ph-small', file_unique_id: 'u-small', file_size: 1500, width: 90, height: 90 },
    { file_id: 'ph-big', file_unique_id: 'u-big', file_size: 120000, width: 1280, height: 960 },
  ],
};

interface Case {
  name: string;
  projectId: string;
  headers: Record<string, string>;
  body: string;
  status: number;
  response: unknown;
  /** The live bot's update ids stored after the case, in job_key order. The tombstone bot stores none. */
  stored: number[];
  /** The stored payload of one update, where the case pins it. */
  payload?: { updateId: number; value: Record<string, unknown> };
  /** The global handler's error line, where the case throws. */
  errorLine?: string;
  /** The request's audit principal, where the case pins it: `{}` is nobody. */
  principal?: AuditPrincipal;
}

const CASES: Case[] = [
  {
    name: "a project id that is not a UUID gets the validator's 400",
    projectId: 'not-a-uuid',
    headers: SIGNED,
    body: message(1000),
    status: 400,
    response: {
      error: true,
      message: 'Validation failed',
      status: 400,
      issues: [{ validation: 'uuid', code: 'invalid_string', message: 'Invalid uuid', path: ['projectId'] }],
      issue_count: 1,
    },
    stored: [],
  },
  {
    name: "malformed JSON sent as application/json gets the validator's 400 before the secret lookup",
    projectId: UNKNOWN,
    headers: { 'content-type': 'application/json' },
    body: '{',
    status: 400,
    response: { error: true, message: 'Malformed JSON in request body', status: 400 },
    stored: [],
  },
  {
    name: 'a project with no webhook secret gets 404',
    projectId: UNKNOWN,
    headers: SIGNED,
    body: message(1000),
    status: 404,
    response: { error: 'Not configured' },
    stored: [],
  },
  {
    name: 'a request without the secret header gets 401',
    projectId: LIVE,
    headers: { 'content-type': 'application/json' },
    body: message(1000),
    status: 401,
    response: { error: 'Invalid secret' },
    stored: [],
  },
  {
    name: 'a wrong secret of the same length gets 401',
    projectId: LIVE,
    headers: { ...SIGNED, 'x-telegram-bot-api-secret-token': 'parity-secreT' },
    body: message(1000),
    status: 401,
    response: { error: 'Invalid secret' },
    stored: [],
    principal: {},
  },
  {
    name: "a body that is not JSON, sent as text/plain, gets the handler's 400",
    projectId: LIVE,
    headers: { ...SIGNED, 'content-type': 'text/plain' },
    body: '{',
    status: 400,
    response: { error: 'Invalid JSON' },
    stored: [],
  },
  {
    name: 'a deleted project that kept its secret (a tombstone) gets 200 and stores nothing',
    projectId: TOMBSTONE,
    headers: SIGNED,
    body: message(1001),
    status: 200,
    response: { ok: true },
    stored: [],
  },
  {
    name: 'a message gets 200 after its row is stored, attributed to Telegram',
    projectId: LIVE,
    headers: SIGNED,
    body: message(1001),
    status: 200,
    response: { ok: true },
    stored: [1001],
    principal: {
      projectId: LIVE,
      actorUserId: null,
      actorType: 'system',
      authoritativeSource: 'integration',
      authMethod: { kind: 'webhook_signature', provider: 'telegram' },
    },
    payload: {
      updateId: 1001,
      value: {
        id: '1001',
        source: `telegram:${BOT}`,
        type: 'telegram.message.created',
        time: new Date(DATE * 1000).toISOString(),
        subject: '777',
        // The inbox orders a chat's events by Telegram's update_id (#11191).
        sequence: 1001,
        projectId: LIVE,
        data: {
          message: { message_id: 1001, date: DATE, chat: { id: 777, type: 'private' }, from: { id: 111, username: 'synthetic' }, text: 'hello' },
        },
      },
    },
  },
  {
    name: 'the same update again (a Telegram retry) gets 200 and leaves one row',
    projectId: LIVE,
    headers: SIGNED,
    body: message(1001),
    status: 200,
    response: { ok: true },
    stored: [1001],
  },
  {
    name: 'a valid update sent as text/plain is stored like JSON',
    projectId: LIVE,
    headers: { ...SIGNED, 'content-type': 'text/plain' },
    body: message(1002),
    status: 200,
    response: { ok: true },
    stored: [1001, 1002],
  },
  {
    name: 'a button press gets 200 and stores no names and no message text',
    projectId: LIVE,
    headers: SIGNED,
    body: press(1003),
    status: 200,
    response: { ok: true },
    stored: [1001, 1002, 1003],
    payload: {
      updateId: 1003,
      value: {
        id: '1003',
        source: `telegram:${BOT}`,
        type: 'telegram.callback_query.created',
        time: expect.any(String),
        subject: '777',
        // The inbox orders a chat's events by Telegram's update_id (#11191).
        sequence: 1003,
        projectId: LIVE,
        data: {
          callback_query: {
            id: 'cbq-parity',
            from: { id: 111, username: 'synthetic' },
            data: 'kq:parity:0',
            message: { message_id: 50, chat: { id: 777, type: 'private' } },
          },
        },
      },
    },
  },
  {
    name: 'an edited message gets 200 and stores nothing',
    projectId: LIVE,
    headers: SIGNED,
    body: JSON.stringify({
      update_id: 1004,
      edited_message: { message_id: 1, date: DATE, chat: { id: 777, type: 'private' }, from: { id: 111 }, text: 'edited' },
    }),
    status: 200,
    response: { ok: true },
    stored: [1001, 1002, 1003],
  },
  {
    name: 'a message from a bot gets 200 and stores nothing',
    projectId: LIVE,
    headers: SIGNED,
    body: message(1005, { id: 222, is_bot: true }),
    status: 200,
    response: { ok: true },
    stored: [1001, 1002, 1003],
  },
  {
    name: 'a JSON null body gets the global 500 and stores nothing',
    projectId: LIVE,
    headers: SIGNED,
    body: 'null',
    status: 500,
    response: GLOBAL_500,
    stored: [1001, 1002, 1003],
    errorLine: `POST /v1/webhooks/telegram/${LIVE} -> 500 [TypeError] null is not an object (evaluating 'update.message')`,
  },
  {
    name: 'a store that fails gets the global 500 and stores nothing',
    projectId: LIVE,
    headers: SIGNED,
    body: message(FAILING_UPDATE),
    status: 500,
    response: GLOBAL_500,
    stored: [1001, 1002, 1003],
    errorLine: `POST /v1/webhooks/telegram/${LIVE} -> 500 [DB ERROR P0001]`,
  },
  {
    name: 'a photo with no text gets 200 and is stored as sent, its sizes included',
    projectId: LIVE,
    headers: SIGNED,
    body: JSON.stringify({ update_id: 1006, message: PHOTO }),
    status: 200,
    response: { ok: true },
    stored: [1001, 1002, 1003, 1006],
    payload: {
      updateId: 1006,
      value: {
        id: '1006',
        source: `telegram:${BOT}`,
        type: 'telegram.message.created',
        time: new Date(DATE * 1000).toISOString(),
        subject: '777',
        // The inbox orders a chat's events by Telegram's update_id (#11191).
        sequence: 1006,
        projectId: LIVE,
        data: { message: PHOTO },
      },
    },
  },
  {
    name: 'a service message (a member joins) gets 200 and stores nothing',
    projectId: LIVE,
    headers: SIGNED,
    body: JSON.stringify({
      update_id: 1007,
      message: { message_id: 1007, date: DATE, chat: { id: 777, type: 'group' }, from: { id: 111 }, new_chat_members: [{ id: 5 }] },
    }),
    status: 200,
    response: { ok: true },
    stored: [1001, 1002, 1003, 1006],
  },
];

const ourRows = () => or(like(jobQueue.jobKey, `telegram:${BOT}:%`), like(jobQueue.jobKey, `telegram:${TOMBSTONE_BOT}:%`));
const errorLog = spyOn(logger, 'error');

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'telegram-webhook-parity' });
  await db.insert(projects).values([
    { projectId: LIVE, accountId: ACCOUNT, name: 'telegram-webhook-live', repoUrl: 'file:///nonexistent/live.git' },
    { projectId: TOMBSTONE, accountId: ACCOUNT, name: 'telegram-webhook-tombstone', repoUrl: 'file:///nonexistent/tombstone.git' },
  ]);
  await saveTelegramInstall({ projectId: LIVE, botId: BOT, username: 'parity_bot', token: `${BOT}:${'A'.repeat(35)}`, webhookSecret: SECRET });
  await saveTelegramInstall({
    projectId: TOMBSTONE,
    botId: TOMBSTONE_BOT,
    username: 'parity_tombstone_bot',
    token: `${TOMBSTONE_BOT}:${'A'.repeat(35)}`,
    webhookSecret: SECRET,
  });
  // A tombstone: only the status changed; the install and its secret stay.
  await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, TOMBSTONE));
  await db.execute(
    sql.raw(`create function kortix.telegram_parity_store_failure() returns trigger language plpgsql as $$ begin
      if new.job_key like 'telegram:%:${FAILING_UPDATE}' then raise exception 'synthetic store failure'; end if;
      return new; end $$`),
  );
  await db.execute(
    sql.raw(`create trigger telegram_parity_store_failure before insert on kortix.job_queue
      for each row execute function kortix.telegram_parity_store_failure()`),
  );
});

beforeEach(() => errorLog.mockClear());

afterAll(async () => {
  errorLog.mockRestore();
  await db.execute(sql.raw('drop trigger if exists telegram_parity_store_failure on kortix.job_queue'));
  await db.execute(sql.raw('drop function if exists kortix.telegram_parity_store_failure()'));
  await db.delete(jobQueue).where(ourRows());
  await deleteTelegramInstall(LIVE);
  await deleteTelegramInstall(TOMBSTONE);
  await db.delete(projects).where(inArray(projects.projectId, [LIVE, TOMBSTONE]));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('Telegram webhook parity table — migrated PostgreSQL', () => {
  for (const c of CASES) {
    test(c.name, async () => {
      // An open audit scope, as the server edge opens one, so the route's principal bind is visible.
      const path = `/v1/webhooks/telegram/${c.projectId}`;
      const { res, principal } = await runWithContext('POST', path, async () => {
        const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
        return { res: await app.request(path, { method: 'POST', headers: c.headers, body: c.body }), principal: scope.principal };
      });
      const rows = await db
        .select({ queue: jobQueue.queue, jobKey: jobQueue.jobKey, maxAttempts: jobQueue.maxAttempts, payload: jobQueue.payload })
        .from(jobQueue)
        .where(ourRows())
        .orderBy(asc(jobQueue.jobKey));
      expect({
        status: res.status,
        response: await res.json(),
        rows: rows.map((r) => [r.queue, r.jobKey, r.maxAttempts]),
        errorLines: errorLog.mock.calls.map(([line]) => line),
      }).toEqual({
        status: c.status,
        response: c.response,
        rows: c.stored.map((id) => ['integration.events', `telegram:${BOT}:${id}`, 4]),
        errorLines: c.errorLine ? [c.errorLine] : [],
      });
      if (c.principal) expect(principal).toEqual(c.principal);
      if (c.payload) {
        expect(rows.find((r) => r.jobKey === `telegram:${BOT}:${c.payload!.updateId}`)?.payload).toEqual(c.payload.value);
      }
    });
  }
});
