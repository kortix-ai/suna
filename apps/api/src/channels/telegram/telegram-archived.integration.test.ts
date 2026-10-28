/**
 * Real-Postgres contract: the Telegram bot of a deleted project answers no one.
 *
 * A project has one end state, `status = 'archived'`, and one way to reach it:
 * `DELETE /v1/projects/:id` (projects/routes/project-settings.ts). No route
 * restores it (KRTX-3384). Two starting points:
 * - `tombstone`: only the status changed (`archiveProjectAndRevokeTokens`); the
 *   install, its secrets and the bot's webhook stay. Every project deleted
 *   before the delete released its bot looks like this.
 * - `deleted`: the project went through the real DELETE route.
 *
 * The session lifecycle is the real one: its archived guards
 * (create-session.ts, continue-session.ts) answer before any sandbox.
 * Telegram is a local fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  chatInstalls,
  chatThreads,
  jobQueue,
  projectSecrets,
  projectSessions,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { config } from '../../config';
import { archiveProjectAndRevokeTokens } from '../../projects/lib/project-deletion';
import { registerProjectSettingsRoutes } from '../../projects/routes/project-settings';
import { projectsApp } from '../../projects/surface';
import { db } from '../../shared/db';
import { bindChatThread } from '../core/threads';
import { telegramWebhookApp } from '../telegram-webhook';
import { saveTelegramInstall, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET } from './installs';
import { handleTelegramEvent, telegramMessageEvent, type TelegramMessage } from './session';

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const ALLOWED = '111';
const STRANGER = '999';
const SECRET = 's';
const BOUND_CHAT = 778;
const TELEGRAM_SECRETS = [TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME];

interface Fixture {
  state: 'tombstone' | 'deleted' | 'moved' | 'revoked' | 'unreachable';
  project: string;
  botId: string;
  token: string;
  session: string;
  /** The Bot API methods the delete called for this bot. */
  deleteCalls: string[];
}

function fixture(state: Fixture['state']): Fixture {
  const botId = String(5_000_000_000 + Math.floor(Math.random() * 1_000_000));
  return { state, project: crypto.randomUUID(), botId, token: `${botId}:${'A'.repeat(35)}`, session: crypto.randomUUID(), deleteCalls: [] };
}

type Call = { botId: string; method: string; body: Record<string, unknown> };
const calls: Call[] = [];
/** The webhook URL `getWebhookInfo` reports per bot id. */
const webhookUrl = new Map<string, string>();
/** The HTTP status every Bot API call of a bot id fails with: 401 a revoked token, 500 an outage. */
const failWith = new Map<string, number>();
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const [, botToken, method] = new URL(req.url).pathname.split('/');
    const botId = (botToken ?? '').replace(/^bot/, '').split(':')[0]!;
    calls.push({ botId, method: method ?? '', body: (await req.json().catch(() => ({}))) as Record<string, unknown> });
    const failure = failWith.get(botId);
    if (failure) return Response.json({ ok: false, description: failure === 401 ? 'Unauthorized' : 'synthetic failure' }, { status: failure });
    if (method === 'getWebhookInfo') {
      return Response.json({ ok: true, result: { url: webhookUrl.get(botId) ?? '', allowed_updates: ['message', 'callback_query'] } });
    }
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true });
  },
});
const botCalls = (f: Fixture) => calls.filter((c) => c.botId === f.botId);

registerProjectSettingsRoutes();
/** A request as the account owner, through the real project routes. */
function asOwner(method: string, path: string) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('userId', OWNER);
    c.set('authType', 'jwt');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app.request(path, { method });
}

async function seed(f: Fixture) {
  await db.insert(projects).values({
    projectId: f.project,
    accountId: ACCOUNT,
    name: `telegram-${f.state}`,
    repoUrl: `file:///nonexistent/telegram-${f.state}.git`,
    metadata: { telegram: { allowedUserIds: [ALLOWED] } },
  });
  await saveTelegramInstall({ projectId: f.project, botId: f.botId, username: 'synthetic_bot', token: f.token, webhookSecret: SECRET });
  await db.insert(projectSessions).values({ sessionId: f.session, accountId: ACCOUNT, projectId: f.project, branchName: f.session, createdBy: OWNER });
  webhookUrl.set(f.botId, `https://example.test/v1/webhooks/telegram/${f.project}`);
}

async function deleteProject(f: Fixture) {
  const before = botCalls(f).length;
  if (f.state === 'tombstone') {
    expect(await archiveProjectAndRevokeTokens(f.project, ACCOUNT)).toBeTruthy();
  } else {
    const res = await asOwner('DELETE', `/v1/projects/${f.project}`);
    expect(res.status).toBe(200);
  }
  f.deleteCalls = botCalls(f).slice(before).map((c) => c.method);
  const [row] = await db.select({ status: projects.status }).from(projects).where(eq(projects.projectId, f.project));
  expect(row!.status).toBe('archived');
}

let updateId = 1;
function message(f: Fixture, text: string, from = ALLOWED, chatId = 779) {
  const m: TelegramMessage = {
    message_id: updateId,
    date: 1_760_000_000,
    chat: { id: chatId, type: 'private' },
    from: { id: Number(from), username: `synthetic_${from}`, first_name: 'Synthetic' },
    text,
  };
  return telegramMessageEvent(f.project, f.botId, { update_id: updateId++, message: m })!;
}

/** What the project's chat surface shows after an inbound message. */
async function outcome(f: Fixture, threw: string | null = null) {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, f.project));
  const requests = ((row!.metadata as { telegram?: { accessRequests?: Array<{ id: string }> } } | null)?.telegram?.accessRequests ?? []).map((r) => r.id);
  const commands = await db
    .select({ type: sessionLifecycleCommands.commandType, status: sessionLifecycleCommands.status })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.projectId, f.project));
  const sessions = await db.select({ id: projectSessions.sessionId }).from(projectSessions).where(eq(projectSessions.projectId, f.project));
  const stored = await db.select({ key: jobQueue.jobKey }).from(jobQueue).where(like(jobQueue.jobKey, `telegram:${f.botId}:%`));
  return {
    threw,
    telegram: botCalls(f).map((c) => (c.method === 'sendMessage' ? `sendMessage: ${String(c.body.text)}` : c.method)),
    lifecycle: commands.map((c) => `${c.type}:${c.status}`),
    sessions: sessions.length,
    accessRequested: requests.includes(STRANGER),
    storedUpdates: stored.length,
  };
}

/** A deleted project's bot: no Bot API call, no lifecycle row, no new session, nothing recorded. */
const NOTHING = { threw: null, telegram: [], lifecycle: [], sessions: 1, accessRequested: false, storedUpdates: 0 };

async function consume(f: Fixture, event: ReturnType<typeof message>) {
  const threw = await handleTelegramEvent(event).then(
    () => null,
    (error: unknown) => String(error),
  );
  return outcome(f, threw);
}

beforeAll(async () => {
  (config as { TELEGRAM_API_URL: string }).TELEGRAM_API_URL = fake.url.origin;
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'telegram-archived-test' });
  // The account owner: the automation actor a channel session runs as, and the caller of the DELETE route.
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
});

afterAll(() => {
  fake.stop(true);
});

for (const f of [fixture('tombstone'), fixture('deleted')]) {
  describe(`Telegram on a deleted project (${f.state}) — migrated PostgreSQL`, () => {
    beforeAll(async () => {
      await seed(f);
      await deleteProject(f);
    });

    beforeEach(async () => {
      calls.length = 0;
      await db.delete(jobQueue).where(like(jobQueue.jobKey, `telegram:${f.botId}:%`));
      await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, f.project));
      await db.delete(chatThreads).where(eq(chatThreads.workspaceId, f.botId));
      await bindChatThread({ projectId: f.project, platform: 'telegram', workspaceId: f.botId, threadId: String(BOUND_CHAT), sessionId: f.session });
    });

    test('the webhook stores no update', async () => {
      const event = message(f, 'hello');
      const res = await telegramWebhookApp.request(`/${f.project}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify({ update_id: Number(event.id), message: event.data.message }),
      });
      // A tombstone still has its secret: a 200 tells Telegram not to retry.
      // The delete removed the secret: the answer of a disconnected bot.
      expect({ status: res.status, ...(await outcome(f)) }).toEqual({ status: f.state === 'tombstone' ? 200 : 404, ...NOTHING });
    });

    test('an update stored before the delete: an allowed sender in a new chat gets no reply and starts no session', async () => {
      expect(await consume(f, message(f, 'summarize the release'))).toEqual(NOTHING);
    });

    test('an update stored before the delete: an allowed sender in a chat bound to a project session gets no follow-up and no reply', async () => {
      expect(await consume(f, message(f, 'and the changelog', ALLOWED, BOUND_CHAT))).toEqual(NOTHING);
    });

    test('an update stored before the delete: a stranger in a private chat gets no pairing reply, and no access request is stored', async () => {
      expect(await consume(f, message(f, 'let me in', STRANGER, Number(STRANGER)))).toEqual(NOTHING);
    });

    if (f.state === 'deleted') {
      test('the delete releases the bot: the webhook that points at this project, the install and its secrets', async () => {
        const installs = await db.select().from(chatInstalls).where(eq(chatInstalls.projectId, f.project));
        const secrets = await db
          .select({ name: projectSecrets.name })
          .from(projectSecrets)
          .where(and(eq(projectSecrets.projectId, f.project), inArray(projectSecrets.name, TELEGRAM_SECRETS)));
        expect({ deleteCalls: f.deleteCalls, installs: installs.length, secrets: secrets.map((s) => s.name) }).toEqual({
          deleteCalls: ['getWebhookInfo', 'deleteWebhook'],
          installs: 0,
          secrets: [],
        });
      });
    }
  });
}

describe('Telegram bot connected to another project since — migrated PostgreSQL', () => {
  const f = fixture('moved');
  beforeAll(async () => {
    await seed(f);
    // The same bot was connected to another project later: its webhook points there.
    webhookUrl.set(f.botId, `https://example.test/v1/webhooks/telegram/${crypto.randomUUID()}`);
    await deleteProject(f);
  });

  test('the delete leaves the other project its webhook and still removes this install', async () => {
    const installs = await db.select().from(chatInstalls).where(eq(chatInstalls.projectId, f.project));
    expect({ deleteCalls: f.deleteCalls, installs: installs.length }).toEqual({ deleteCalls: ['getWebhookInfo'], installs: 0 });
  });
});

describe('Telegram refuses or fails during the delete — migrated PostgreSQL', () => {
  for (const [state, status, bot] of [['revoked', 401, 'a revoked bot'], ['unreachable', 500, 'an unreachable bot']] as const) {
    test(`${bot} (HTTP ${status}) does not block the delete: the project is archived, the install and its secrets go`, async () => {
      const f = fixture(state);
      await seed(f);
      failWith.set(f.botId, status);
      await deleteProject(f);
      const installs = await db.select().from(chatInstalls).where(eq(chatInstalls.projectId, f.project));
      const secrets = await db
        .select({ name: projectSecrets.name })
        .from(projectSecrets)
        .where(and(eq(projectSecrets.projectId, f.project), inArray(projectSecrets.name, TELEGRAM_SECRETS)));
      expect({ deleteCalls: f.deleteCalls, installs: installs.length, secrets: secrets.map((s) => s.name) }).toEqual({
        deleteCalls: ['getWebhookInfo'],
        installs: 0,
        secrets: [],
      });
    });
  }
});
