/**
 * Real-Postgres contract for the Discord channel. Every case enters where
 * Discord enters: the interactions webhook (the real route, signed with a test
 * Ed25519 key), the Gateway intake (`intakeMessage`, and the Gateway client
 * against a fake WebSocket), and the job worker that runs the stored events.
 * Discord's REST API is a local fake that records each call. The session
 * lifecycle is cut at `createSession` / `deliverThroughQueue`. Synthetic ids.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { accounts, chatChannelBindings, chatInstalls, chatThreads, jobQueue, projectSessions, projects } from '@kortix/db';
import { and, eq, like } from 'drizzle-orm';
import { config } from '../../config';
import { discordCallRefusal, resetDiscordScopeForTest } from '../../connectors/channel-discord-scope';
import { db } from '../../shared/db';
import { runJobBatch } from '../../shared/job-queue';
import { undeclaredChannelArg } from '../../connectors/channels';
import * as defaultModel from '../../llm-gateway/resolution/default-model';
import { ensureChatBinding } from '../core/settings';
import { resetChannelLifecycleForTest, setChannelLifecycleForTest } from '../core/conversation';
import { settleSessionChat } from '../core/session-notice';
import { bindChatThread } from '../core/threads';
import { channelAppWebhookRoutes } from '../inbound/webhook-routes';
import { snowflakeSequence } from './api';
import {
  commandShape,
  discordCommandDefinitions,
  DiscordGateway,
  discordIntents,
  freshEdit,
  type GatewayState,
  intakeMessage,
  leaveIfOrphan,
  reconcileGuilds,
  rememberBotRole,
  resetDiscordGatewayCacheForTest,
  type GatewayMessage,
} from './gateway';
import { discordInbound } from './inbound';
import { bindDiscordChannel, claimDiscordChannel } from './connect';
import { discordEnvelope, discordPort, handleDiscordMessage, tellDeadDiscordEvent } from './session';
import { forgetDiscordChannel, forgetDiscordGuild, loadDiscordInstall, releaseDiscordInstall, saveDiscordInstall } from './installs';
import { resolveDiscordRoute } from './routing';

const webhook = channelAppWebhookRoutes(discordInbound);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const ACTOR = crypto.randomUUID();
const APP = '710000000000000001';
const BOT = '710000000000000002';
const GUILD = '720000000000000001';
const FOREIGN_GUILD = '720000000000000099';
const CHANNEL = '730000000000000001';
const OTHER_CHANNEL = '730000000000000002';
const FOREIGN_CHANNEL = '730000000000000099';
const ALLOWED = '740000000000000001';
const STRANGER = '740000000000000002';
const DM = '750000000000000001';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// The raw key is the last 32 bytes of its SPKI encoding.
const PUBLIC_KEY_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

let counter = 0;
/** A snowflake stamped now, rising: Discord's id shape and order. */
const snowflake = () => String(((BigInt(Date.now() - 1_420_070_400_000) << 22n) | BigInt(counter++ & 0xfff)));

/** Every REST call the fake received: `METHOD /path` and its body. */
const calls: Array<{ route: string; body: any }> = [];
/** Channels the fake describes (`GET /channels/{id}`). */
const channels = new Map<string, { id: string; type: number; guild_id?: string; parent_id?: string | null; name?: string }>();
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v10/, '');
    const body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined);
    calls.push({ route: `${req.method} ${path}`, body });
    const scripted = failures.get(`${req.method} ${path}`);
    if (scripted?.times) {
      scripted.times -= 1;
      return Response.json(scripted.body, { status: scripted.status });
    }
    const thread = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path);
    if (thread) {
      channels.set(thread[2]!, { id: thread[2]!, type: 11, guild_id: GUILD, parent_id: thread[1]!, name: body?.name });
      return Response.json({ id: thread[2] });
    }
    const channel = /^\/channels\/(\d+)$/.exec(path);
    if (channel && req.method === 'GET') {
      const found = channels.get(channel[1]!);
      return found ? Response.json(found) : Response.json({ message: 'Unknown Channel', code: 10003 }, { status: 404 });
    }
    if (/\/typing$/.test(path)) return new Response(null, { status: 204 });
    if (path.startsWith('/cdn/') || path === '/elsewhere.txt') return new Response('quarterly numbers: 42\n', { headers: { 'content-type': 'text/plain' } });
    return Response.json({ id: snowflake() });
  },
});
const routes = () => calls.map((c) => c.route);
/** A route the fake refuses the next `times` calls of, with Discord's error body. */
const failures = new Map<string, { status: number; body: unknown; times: number }>();

/** The fields of the session create the core asked for. */
const created: Array<Record<string, any>> = [];
const delivered: Array<Record<string, any>> = [];

async function newSession(projectId = PROJECT, metadata?: Record<string, unknown>) {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({ sessionId, accountId: ACCOUNT, projectId, branchName: sessionId, createdBy: ACTOR, ...(metadata ? { metadata } : {}) });
  return sessionId;
}

function message(over: Partial<GatewayMessage> & { channel_id: string }): GatewayMessage {
  return {
    id: snowflake(),
    type: 0,
    guild_id: GUILD,
    author: { id: ALLOWED, username: 'synthetic_sam', global_name: 'Sam' },
    content: `<@${BOT}> what changed in the release?`,
    timestamp: new Date().toISOString(),
    mentions: [{ id: BOT, username: 'Kortix' }],
    attachments: [],
    ...over,
  };
}

/** A signed request to the interactions webhook. */
function interact(body: Record<string, unknown>, opts: { badSignature?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + raw), privateKey).toString('hex');
  return webhook.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': opts.badSignature ? signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) : signature,
      'x-signature-timestamp': timestamp,
    },
    body: raw,
  });
}

function command(name: string, channel: Record<string, unknown>, user = ALLOWED) {
  return {
    id: snowflake(),
    type: 2,
    token: `token-${counter}`,
    application_id: APP,
    guild_id: GUILD,
    channel_id: channel.id,
    channel,
    member: { user: { id: user, username: 'synthetic_sam' } },
    data: { name },
  };
}

/** Run the worker until no Discord event is queued. */
async function drain() {
  for (let pass = 0; pass < 8; pass++) {
    const queued = await db.select({ id: jobQueue.jobId }).from(jobQueue).where(and(like(jobQueue.jobKey, 'discord:%'), eq(jobQueue.status, 'queued')));
    if (!queued.length) return;
    await runJobBatch();
  }
  throw new Error('Discord events still queued after 8 worker passes');
}

beforeAll(async () => {
  Object.assign(config as Record<string, unknown>, {
    DISCORD_API_URL: `${fake.url.origin}/api/v10`,
    DISCORD_APPLICATION_ID: APP,
    DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
    DISCORD_CLIENT_SECRET: 'synthetic-secret',
    DISCORD_BOT_TOKEN: 'synthetic-token',
    // `localhost`: the CDN host. The same server as `127.0.0.1` is another host.
    DISCORD_CDN_URL: `${fake.url.origin}/cdn`,
  });
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'discord-test' });
  for (const [projectId, name] of [[PROJECT, 'discord-main'], [OTHER, 'discord-other']] as const) {
    await db.insert(projects).values({
      splitPending: true,
      projectId,
      accountId: ACCOUNT,
      name,
      repoUrl: `file:///nonexistent/${name}.git`,
      metadata: { discord: { allowedUserIds: [ALLOWED] } },
    });
  }
  await saveDiscordInstall({ projectId: PROJECT, guildId: GUILD, guildName: 'Synthetic Server' });
  channels.set(CHANNEL, { id: CHANNEL, type: 0, guild_id: GUILD, parent_id: null, name: 'launch' });
  channels.set(OTHER_CHANNEL, { id: OTHER_CHANNEL, type: 0, guild_id: GUILD, parent_id: null, name: 'random' });
  channels.set(FOREIGN_CHANNEL, { id: FOREIGN_CHANNEL, type: 0, guild_id: FOREIGN_GUILD, parent_id: null, name: 'elsewhere' });
  setChannelLifecycleForTest({
    resolveProjectAutomationActor: async () => ACTOR,
    sleep: async () => {},
    createSession: (async (input: Record<string, any>) => {
      created.push(input);
      // The session row keeps the create's metadata, as the lifecycle's does (`discord.channel_id` …).
      const sessionId = await newSession(input.project.projectId, input.metadata);
      const { type: _type, createClaim: _claim, ...thread } = input.postCreate[0];
      await bindChatThread({ ...thread, projectId: input.project.projectId, sessionId });
      return { status: 'created', sessionId };
    }) as never,
    deliverThroughQueue: (async (command: Record<string, any>) => {
      delivered.push(command);
      return 'queued';
    }) as never,
  });
});

beforeEach(() => {
  failures.clear();
  calls.length = 0;
  created.length = 0;
  delivered.length = 0;
});

afterAll(async () => {
  resetChannelLifecycleForTest();
  fake.stop(true);
});

describe('the interactions webhook', () => {
  test('answers PING with PONG and refuses a forged or unsigned request', async () => {
    const pong = await interact({ id: snowflake(), type: 1, token: 't', application_id: APP });
    expect(pong.status).toBe(200);
    expect(await pong.json()).toEqual({ type: 1 });

    const forged = await interact({ id: snowflake(), type: 1, token: 't' }, { badSignature: true });
    expect(forged.status).toBe(401);
    const unsigned = await webhook.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":1}' });
    expect(unsigned.status).toBe(401);
  });

  test('/help is deferred at once, stored, then drawn over the deferred reply', async () => {
    const body = command('help', { id: CHANNEL, type: 0, name: 'launch' });
    const res = await interact(body);
    expect(await res.json()).toEqual({ type: 5 });
    const [job] = await db.select().from(jobQueue).where(eq(jobQueue.jobKey, `discord:${GUILD}:${body.id}`));
    expect(job?.orderKey).toBe(`discord:${GUILD}:${CHANNEL}`);
    expect(job?.orderSeq).toBe(snowflakeSequence(body.id));

    await drain();
    const drawn = calls.find((c) => c.route === `PATCH /webhooks/${APP}/${body.token}/messages/@original`);
    expect(drawn?.body.content).toContain('/new');
    expect(drawn?.body.content).toContain('/model');
  });

  test('a command from someone the project does not allow is refused at once, only to them, and nothing is stored', async () => {
    const body = command('status', { id: CHANNEL, type: 0, name: 'launch' }, STRANGER);
    const reply = (await (await interact(body)).json()) as { type: number; data: { content: string; flags: number } };
    // A deferred reply (5) is public, and Discord cannot make it private afterwards.
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toContain(`user ID ${STRANGER}`);
    expect(await db.select().from(jobQueue).where(eq(jobQueue.jobKey, `discord:${GUILD}:${body.id}`))).toEqual([]);
  });

  test('a person removed after the webhook took their command hears the refusal privately: the public deferred reply goes', async () => {
    const body = command('status', { id: CHANNEL, type: 0, name: 'launch' });
    expect(await (await interact(body)).json()).toEqual({ type: 5 });
    const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
    await db.update(projects).set({ metadata: { discord: { allowedUserIds: [] } } }).where(eq(projects.projectId, PROJECT));
    try {
      await drain();
    } finally {
      await db.update(projects).set({ metadata: row!.metadata }).where(eq(projects.projectId, PROJECT));
    }
    expect(routes()).toContain(`DELETE /webhooks/${APP}/${body.token}/messages/@original`);
    const notice = calls.find((c) => c.route === `POST /webhooks/${APP}/${body.token}`);
    expect(notice?.body.flags).toBe(64);
    expect(notice?.body.content).toContain(`user ID ${ALLOWED}`);
    expect(routes()).not.toContain(`PATCH /webhooks/${APP}/${body.token}/messages/@original`);
  });

  test('a command where the bot cannot post says which permission to grant, privately, and stores nothing', async () => {
    const view = String(1n << 10n);
    const post = String((1n << 10n) | (1n << 11n));
    const noSend = (await (await interact({ ...command('model', { id: CHANNEL, type: 0, name: 'launch' }), app_permissions: view })).json()) as any;
    expect(noSend).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(noSend.data.content).toContain('Send Messages');
    const privateThread = { id: '760000000000000601', type: 12, parent_id: CHANNEL, name: 'private' };
    const notIn = (await (await interact({ ...command('help', privateThread), app_permissions: '0' })).json()) as any;
    expect(notIn.data.content).toContain('private thread');
    expect(await (await interact({ ...command('help', { id: CHANNEL, type: 0, name: 'launch' }), app_permissions: post })).json()).toEqual({ type: 5 });
    await drain();
  });

  test('a server no project has hears where to connect it, and nothing is stored', async () => {
    const body = { ...command('status', { id: FOREIGN_CHANNEL, type: 0 }), guild_id: FOREIGN_GUILD };
    const reply = (await (await interact(body)).json()) as { type: number; data: { content: string; flags: number } };
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toContain('not connected to a Kortix workspace');
    expect(await db.select().from(jobQueue).where(eq(jobQueue.jobKey, `discord:${FOREIGN_GUILD}:${body.id}`))).toEqual([]);
  });
});

describe('a conversation', () => {
  test('a mention in a text channel starts a thread on the message and one session bound to it', async () => {
    const m = message({ channel_id: CHANNEL });
    expect(await intakeMessage(m, BOT)).toBe('stored');
    await drain();

    expect(calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages/${m.id}/threads`)?.body.auto_archive_duration).toBe(1440);
    expect(routes()).toContain(`POST /channels/${m.id}/typing`);
    expect(created).toHaveLength(1);
    const [create] = created;
    expect(create!.source).toBe('discord');
    expect(create!.postCreate[0]).toMatchObject({ type: 'bind_chat_thread', platform: 'discord', workspaceId: GUILD, threadId: m.id });
    expect(create!.metadata.discord).toMatchObject({ guild_id: GUILD, channel_id: CHANNEL, thread_id: m.id, author_id: ALLOWED });
    const prompt = String(create!.postCreate[1].text);
    expect(prompt).toStartWith('[Discord · #launch · message from Sam (@synthetic_sam)]\nwhat changed in the release?');
    expect(prompt).toContain(`kortix connectors call kortix_discord.send_message '{"channel_id":"${m.id}","content":"<reply>"}'`);
    const [thread] = await db.select().from(chatThreads).where(and(eq(chatThreads.platform, 'discord'), eq(chatThreads.threadId, m.id)));
    expect(thread?.projectId).toBe(PROJECT);
    // The channel stays this project's when another project installs the server.
    const [binding] = await db.select().from(chatChannelBindings).where(and(eq(chatChannelBindings.platform, 'discord'), eq(chatChannelBindings.channelId, CHANNEL)));
    expect(binding?.projectId).toBe(PROJECT);
  });

  test("a message's files reach the prompt from Discord's CDN only; a file elsewhere is never fetched", async () => {
    const m = message({
      channel_id: CHANNEL,
      content: `<@${BOT}> read the attached report`,
      attachments: [
        { id: '770000000000000001', filename: 'q3 report.txt', size: 22, url: `${fake.url.origin}/cdn/attachments/1/q3.txt`, content_type: 'text/plain' },
        { id: '770000000000000002', filename: 'notes.txt', size: 22, url: `http://127.0.0.1:${fake.port}/elsewhere.txt`, content_type: 'text/plain' },
      ],
    });
    expect(await intakeMessage(m, BOT)).toBe('stored');
    await drain();
    const prompt = created[0]!.postCreate[1];
    expect(prompt.parts.filter((p: { type: string }) => p.type === 'file')).toEqual([
      expect.objectContaining({ type: 'file', filename: 'document.txt', mime: 'text/plain' }),
    ]);
    expect(String(prompt.parts[0].text)).toContain('(file q3 report.txt)');
    expect(routes()).toContain('GET /cdn/attachments/1/q3.txt');
    expect(routes()).not.toContain('GET /elsewhere.txt');
  });

  test("in the session's thread a mention follows up; without the Message Content intent nothing else is read", async () => {
    const start = message({ channel_id: CHANNEL });
    await intakeMessage(start, BOT);
    await drain();
    const sessionId = (await db.select().from(chatThreads).where(eq(chatThreads.threadId, start.id)))[0]!.sessionId;

    expect(await intakeMessage(message({ channel_id: start.id, content: 'people talking', mentions: [] }), BOT)).toBe('ignored');
    const reply = message({ channel_id: start.id, content: `<@${BOT}> and the migration?` });
    expect(await intakeMessage(reply, BOT)).toBe('stored');
    await drain();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ source: 'discord', sessionId, idempotencyKey: `discord:${GUILD}:${reply.id}` });
    expect(String(delivered[0]!.text)).toContain('and the migration?');
    expect(String(delivered[0]!.text)).toContain('The next message that mentions you in this thread continues this session');
    expect(created).toHaveLength(1);
  });

  test("with the Message Content intent the session's thread follows up without a mention; another thread's chatter is not read", async () => {
    (config as Record<string, unknown>).DISCORD_MESSAGE_CONTENT = true;
    try {
      const start = message({ channel_id: CHANNEL });
      await intakeMessage(start, BOT);
      await drain();
      const reply = message({ channel_id: start.id, content: 'and the migration?', mentions: [] });
      expect(await intakeMessage(reply, BOT)).toBe('stored');
      channels.set('760000000000000001', { id: '760000000000000001', type: 11, guild_id: GUILD, parent_id: CHANNEL, name: 'people talking' });
      expect(await intakeMessage(message({ channel_id: '760000000000000001', content: 'lunch?', mentions: [] }), BOT)).toBe('ignored');
      // In the held thread, someone the project does not allow is not stored either: only a mention from them is.
      expect(await intakeMessage(message({ channel_id: start.id, content: 'me too', mentions: [], author: { id: STRANGER, username: 'synthetic_kim' } }), BOT)).toBe('ignored');
      await drain();
      expect(delivered.map((d) => d.idempotencyKey)).toEqual([`discord:${GUILD}:${reply.id}`]);
      expect(String(delivered[0]!.text)).toContain('The next message in this conversation continues this session');
    } finally {
      (config as Record<string, unknown>).DISCORD_MESSAGE_CONTENT = false;
    }
  });

  test("an unknown sender's mention gets the pairing reply and an access request; a thread's other people are not answered", async () => {
    const m = message({ channel_id: CHANNEL, author: { id: STRANGER, username: 'synthetic_kim' } });
    await intakeMessage(m, BOT);
    await drain();
    const pairing = calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages`);
    expect(pairing?.body.content).toContain(`Discord user ID is ${STRANGER}`);
    expect(pairing?.body.message_reference).toEqual({ message_id: m.id, fail_if_not_exists: false });
    expect(created).toHaveLength(0);
    expect((await loadDiscordInstall(PROJECT))?.accessRequests.map((r) => r.id)).toContain(STRANGER);
  });

  test('a DM from an allowed person reaches the one project that allows them', async () => {
    const m = message({ channel_id: DM, guild_id: undefined, content: 'hello from a DM', mentions: [] });
    expect(await intakeMessage(m, BOT)).toBe('stored');
    await drain();
    expect(created).toHaveLength(1);
    expect(created[0]!.postCreate[0]).toMatchObject({ platform: 'discord', workspaceId: GUILD, threadId: DM });
    expect(String(created[0]!.postCreate[1].text)).toStartWith('[Discord · direct message · message from Sam (@synthetic_sam)]');
    expect(routes()).not.toContain(`POST /channels/${DM}/messages/${m.id}/threads`);
  });

  test("a DM from someone no project allows hears their user id once, and nothing is stored", async () => {
    const dm = '750000000000000077';
    const m = message({ channel_id: dm, guild_id: undefined, author: { id: STRANGER, username: 'synthetic_kim' }, mentions: [] });
    expect(await intakeMessage(m, BOT)).toBe('ignored');
    expect(await intakeMessage(message({ ...m, id: snowflake() }), BOT)).toBe('ignored');
    const notices = calls.filter((c) => c.route === `POST /channels/${dm}/messages`);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body.content).toContain(STRANGER);
  });
});

describe('/connect', () => {
  test('lists the projects that have the server, and a press binds the channel to the one picked', async () => {
    await saveDiscordInstall({ projectId: OTHER, guildId: GUILD, guildName: 'Synthetic Server' });
    // Not bound yet: two projects can answer here.
    expect((await resolveDiscordRoute({ guildId: GUILD, channelId: OTHER_CHANNEL })).kind).toBe('ambiguous');

    const list = (await (await interact(command('connect', { id: OTHER_CHANNEL, type: 0, name: 'random' }))).json()) as {
      type: number;
      data: { components: Array<{ components: Array<{ label: string; custom_id: string }> }>; flags: number };
    };
    expect(list.type).toBe(4);
    expect(list.data.flags).toBe(64);
    const buttons = list.data.components.flatMap((row) => row.components);
    expect(buttons.map((b) => b.label).sort()).toEqual(['discord-main', 'discord-other']);

    const press = {
      id: snowflake(),
      type: 3,
      token: `token-press-${counter}`,
      application_id: APP,
      guild_id: GUILD,
      channel_id: OTHER_CHANNEL,
      channel: { id: OTHER_CHANNEL, type: 0, name: 'random' },
      member: { user: { id: ALLOWED, username: 'synthetic_sam' } },
      message: { id: snowflake() },
      data: { custom_id: `kd:${OTHER}`, component_type: 2 },
    };
    expect(await (await interact(press)).json()).toEqual({ type: 6 });
    await drain();
    expect(await resolveDiscordRoute({ guildId: GUILD, channelId: OTHER_CHANNEL })).toEqual({ kind: 'project', projectId: OTHER, guildId: GUILD });
    const told = calls.find((c) => c.route === `POST /webhooks/${APP}/${press.token}`);
    expect(told?.body.content).toContain('discord-other');
    expect(told?.body.flags).toBe(64);
  });

  test('/connect shows a person only the projects that allow them', async () => {
    const reply = (await (await interact(command('connect', { id: OTHER_CHANNEL, type: 0, name: 'random' }, STRANGER))).json()) as {
      data: { content: string; components: unknown[] };
    };
    expect(reply.data.components).toEqual([]);
    expect(reply.data.content).toContain(`allows your Discord account yet`);
    expect(reply.data.content).not.toContain('discord-main');
  });

  test('a forged project button for a project without the server stores nothing', async () => {
    const stranger = crypto.randomUUID();
    const press = {
      id: snowflake(),
      type: 3,
      token: 'token-forged',
      guild_id: GUILD,
      channel_id: CHANNEL,
      channel: { id: CHANNEL, type: 0 },
      member: { user: { id: ALLOWED } },
      message: { id: snowflake() },
      data: { custom_id: `kd:${stranger}`, component_type: 2 },
    };
    const reply = (await (await interact(press)).json()) as { type: number; data: { content: string } };
    expect(reply.type).toBe(4);
    expect(reply.data.content).toContain('out of date');
  });
});

describe('the kortix_discord connector', () => {
  test("acts only in this project's conversations and server", async () => {
    const start = message({ channel_id: CHANNEL });
    await intakeMessage(start, BOT);
    await drain();
    const own = start.id;
    const refusal = (args: Record<string, unknown>, sessionId?: string) => discordCallRefusal({ projectId: PROJECT, sessionId: sessionId ?? null, args });

    expect(await refusal({ channel_id: own })).toBeNull();
    expect(await refusal({ channel_id: CHANNEL })).toBeNull();
    // Bound to the other project by /connect above.
    expect(await refusal({ channel_id: OTHER_CHANNEL })).toContain('not a conversation of this Kortix workspace');
    expect(await refusal({ channel_id: FOREIGN_CHANNEL })).toContain('not a conversation of this Kortix workspace');
    expect(await refusal({ channel_id: 'general' })).toContain('one Discord channel id');
    expect(await refusal({ channel_id: own, message_reference: { message_id: own, channel_id: FOREIGN_CHANNEL } })).toContain('same channel');
    expect(await refusal({ channel_id: own, message_reference: { message_id: own, type: 1 } })).toContain('does not forward');

    // The session the thread started acts only in its thread.
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.threadId, own));
    expect(await refusal({ channel_id: own }, thread!.sessionId)).toBeNull();
    expect(await refusal({ channel_id: CHANNEL }, thread!.sessionId)).toContain(`answers Discord conversation ${own} only`);
  });
});

describe('edge cases', () => {
  test('"@Kortix" alone gets a hint and starts no session; a mention of the app\'s role counts as a mention', async () => {
    expect(await intakeMessage(message({ channel_id: CHANNEL, content: `<@${BOT}>` }), BOT)).toBe('stored');
    await drain();
    expect(created).toHaveLength(0);
    expect(calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages`)?.body.content).toContain('Mention me with what you need');
    expect(routes().some((r) => r.endsWith('/threads'))).toBe(false);

    const ROLE = '780000000000000001';
    rememberBotRole(GUILD, ROLE);
    calls.length = 0;
    const viaRole = message({ channel_id: CHANNEL, content: `<@&${ROLE}> what is the status?`, mentions: [], mention_roles: [ROLE] });
    expect(await intakeMessage(viaRole, BOT)).toBe('stored');
    await drain();
    expect(String(created.at(-1)!.postCreate[1].text)).toContain('\nwhat is the status?');
    // Without the Message Content intent Discord may send a role mention with no text: the hint says why.
    calls.length = 0;
    expect(await intakeMessage(message({ channel_id: CHANNEL, content: '', mentions: [], mention_roles: [ROLE] }), BOT)).toBe('stored');
    await drain();
    expect(calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages`)?.body.content).toContain('not the role');
  });

  test('a person no project allows hears the pairing reply once an hour in a server, however often they mention the app', async () => {
    const someone = '740000000000000077';
    for (let i = 0; i < 3; i++) {
      await intakeMessage(message({ channel_id: CHANNEL, author: { id: someone, username: 'synthetic_lee' } }), BOT);
    }
    await drain();
    expect(calls.filter((c) => c.route === `POST /channels/${CHANNEL}/messages` && String(c.body.content).includes(someone))).toHaveLength(1);
    expect((await loadDiscordInstall(PROJECT))?.accessRequests.map((r) => r.id)).toContain(someone);
  });

  test("Kortix's reply into a thread that archived is posted after it unarchives the thread", async () => {
    const archived = '760000000000000044';
    channels.set(archived, { id: archived, type: 11, guild_id: GUILD, parent_id: CHANNEL, name: 'old' });
    failures.set(`POST /channels/${archived}/messages`, { status: 400, body: { message: 'Thread is archived', code: 50083 }, times: 1 });
    await intakeMessage(message({ channel_id: archived, content: `<@${BOT}>` }), BOT);
    await drain();
    const order = routes().filter((r) => r.includes(archived) && !r.startsWith('GET '));
    expect(order).toEqual([`POST /channels/${archived}/messages`, `PATCH /channels/${archived}`, `POST /channels/${archived}/messages`]);
    expect(calls.find((c) => c.route === `PATCH /channels/${archived}`)?.body).toEqual({ archived: false });
  });

  test('a slash command whose interaction token expired is answered in the channel', async () => {
    const body = command('help', { id: CHANNEL, type: 0, name: 'launch' });
    failures.set(`PATCH /webhooks/${APP}/${body.token}/messages/@original`, { status: 404, body: { message: 'Unknown Webhook', code: 10015 }, times: 1 });
    expect(await (await interact(body)).json()).toEqual({ type: 5 });
    await drain();
    expect(calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages`)?.body.content).toContain('/new');
  });

  test('a deleted thread or channel leaves no conversation and no binding behind', async () => {
    const gone = '760000000000000055';
    const session = await newSession();
    await bindChatThread({ platform: 'discord', workspaceId: GUILD, threadId: gone, projectId: PROJECT, sessionId: session });
    await db.insert(chatChannelBindings).values({ platform: 'discord', platformTeamId: GUILD, channelId: gone, projectId: PROJECT });
    await forgetDiscordChannel(gone);
    expect(await db.select().from(chatThreads).where(eq(chatThreads.threadId, gone))).toEqual([]);
    expect(await db.select().from(chatChannelBindings).where(eq(chatChannelBindings.channelId, gone))).toEqual([]);
  });

  test("a server that removed the bot while no Gateway listened is forgotten at READY; a suspicious READY removes nothing", async () => {
    const gone = '720000000000000777';
    const extra = crypto.randomUUID();
    await db.insert(projects).values({ splitPending: true, projectId: extra, accountId: ACCOUNT, name: 'discord-gone', repoUrl: 'file:///nonexistent/gone.git', metadata: {} });
    await saveDiscordInstall({ projectId: extra, guildId: gone, guildName: null });
    // An empty list is a broken READY, not a bot removed from every server.
    expect(await reconcileGuilds([])).toEqual([]);
    expect(await reconcileGuilds([GUILD])).toEqual([gone]);
    expect(await db.select().from(chatInstalls).where(eq(chatInstalls.platformTeamId, gone))).toEqual([]);
  });

  test('the bot leaves a server no project has, but never one it joined in the last hour (an install in progress)', async () => {
    const orphan = '720000000000000888';
    const now = Date.now();
    expect(await leaveIfOrphan(orphan, new Date(now - 5 * 60_000).toISOString(), now)).toBe(false);
    expect(await leaveIfOrphan(GUILD, new Date(now - 3 * 60 * 60_000).toISOString(), now)).toBe(false);
    expect(await leaveIfOrphan(orphan, new Date(now - 3 * 60 * 60_000).toISOString(), now)).toBe(true);
    expect(routes()).toContain(`DELETE /users/@me/guilds/${orphan}`);
    expect(routes()).not.toContain(`DELETE /users/@me/guilds/${GUILD}`);
  });
});

describe('the shared bot token stays in each project', () => {
  const GUILD_B = '720000000000000002';
  const DM2 = '750000000000000002';
  const LEFT = crypto.randomUUID();

  beforeEach(() => resetDiscordScopeForTest());

  test("a DM moved to another project leaves its old project nothing there, and its history before the move stays closed", async () => {
    await db.insert(projects).values({ splitPending: true, projectId: LEFT, accountId: ACCOUNT, name: 'discord-left', repoUrl: 'file:///nonexistent/left.git', metadata: { discord: { allowedUserIds: [] } } });
    await saveDiscordInstall({ projectId: LEFT, guildId: GUILD_B, guildName: null });
    const old = await newSession(LEFT);
    await bindChatThread({ platform: 'discord', workspaceId: GUILD_B, threadId: DM2, projectId: LEFT, sessionId: old });
    await db.insert(chatChannelBindings).values({ platform: 'discord', platformTeamId: GUILD_B, channelId: DM2, projectId: LEFT, channelType: 'dm' });
    expect(await discordCallRefusal({ projectId: LEFT, args: { channel_id: DM2 } })).toBeNull();

    // The person moves their DM, though the old project no longer allows them: only they press a button in it.
    const moved = await bindDiscordChannel({ guildId: GUILD, threadId: DM2, settingsId: DM2, direct: true, startThread: false, addressed: true, channelName: null, threadName: null }, PROJECT, ALLOWED);
    expect(moved).toBe(true);
    expect(await discordCallRefusal({ projectId: LEFT, args: { channel_id: DM2 } })).toContain('not a conversation of this Kortix workspace');
    expect(await db.select().from(chatThreads).where(and(eq(chatThreads.threadId, DM2), eq(chatThreads.projectId, LEFT)))).toEqual([]);

    expect(await discordCallRefusal({ projectId: PROJECT, actionPath: 'send_message', args: { channel_id: DM2 } })).toBeNull();
    expect(await discordCallRefusal({ projectId: PROJECT, actionPath: 'get_messages', args: { channel_id: DM2 } })).toContain('`after`');
    expect(await discordCallRefusal({ projectId: PROJECT, actionPath: 'get_messages', args: { channel_id: DM2, after: snowflake() } })).toBeNull();
  });

  test('a project that left a server keeps no conversation there, and its old threads route to the server\'s project', async () => {
    const left = '760000000000000009';
    const session = await newSession(LEFT);
    await bindChatThread({ platform: 'discord', workspaceId: GUILD, threadId: left, projectId: LEFT, sessionId: session });
    // LEFT never had GUILD (or left it): its row grants nothing and routes nothing.
    expect(await discordCallRefusal({ projectId: LEFT, args: { channel_id: left } })).not.toBeNull();
    expect(await resolveDiscordRoute({ guildId: GUILD, channelId: CHANNEL, threadId: left })).toMatchObject({ kind: 'project', projectId: PROJECT });
    await releaseDiscordInstall(LEFT);
    expect(await db.select().from(chatThreads).where(eq(chatThreads.projectId, LEFT))).toEqual([]);
  });

  test('in a server shared by two projects, a channel no project holds is refused; path arguments stay in the channel; calls are budgeted', async () => {
    const unbound = '730000000000000003';
    channels.set(unbound, { id: unbound, type: 0, guild_id: GUILD, parent_id: null, name: 'general' });
    // OTHER has the server too (/connect above).
    expect(await discordCallRefusal({ projectId: PROJECT, args: { channel_id: unbound } })).toContain('more than one Kortix workspace');
    await releaseDiscordInstall(OTHER);
    expect(await discordCallRefusal({ projectId: PROJECT, args: { channel_id: unbound } })).toBeNull();

    expect(await discordCallRefusal({ projectId: PROJECT, args: { channel_id: CHANNEL, message_id: '..' } })).toContain('`message_id`');
    expect(await discordCallRefusal({ projectId: PROJECT, args: { channel_id: CHANNEL, message_id: snowflake(), emoji: '..' } })).toContain('`emoji`');

    resetDiscordScopeForTest();
    const verdicts = [];
    for (let i = 0; i < 61; i++) verdicts.push(await discordCallRefusal({ projectId: PROJECT, args: { channel_id: CHANNEL } }));
    expect(verdicts.slice(0, 60).every((v) => v === null)).toBe(true);
    expect(verdicts[60]).toContain('more than 60 Discord calls');
  });
});

describe('the Gateway', () => {
  test('identifies with the intents, hands MESSAGE_CREATE to the intake, and resumes after a reconnect request', async () => {
    const received: Array<{ op: number; d: any }> = [];
    let socket: { send(data: string): void } | null = null;
    const gateway = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          socket = ws;
          ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }));
        },
        message(ws, data) {
          const payload = JSON.parse(String(data));
          received.push(payload);
          if (payload.op === 2) {
            ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-session', resume_gateway_url: `ws://localhost:${gateway.port}`, user: { id: BOT }, guilds: [] } }));
            ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message({ channel_id: CHANNEL }) }));
          }
        },
      },
    });
    (config as Record<string, unknown>).DISCORD_GATEWAY_URL = `ws://localhost:${gateway.port}`;
    const seen: string[] = [];
    const client = new DiscordGateway(async (m, botUserId) => void seen.push(`${botUserId}:${m.channel_id}`), { load: async () => null, save: async () => {} });
    try {
      await client.start();
      for (let i = 0; i < 100 && !seen.length; i++) await Bun.sleep(10);
      const identify = received.find((p) => p.op === 2);
      // GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES; MESSAGE_CONTENT only when the deployment turns it on.
      expect(identify?.d.intents).toBe(4609);
      expect(discordIntents(true)).toBe(4609 + 32768);
      expect(identify?.d.token).toBe('synthetic-token');
      expect(seen).toEqual([`${BOT}:${CHANNEL}`]);

      // Discord asks for a reconnect: the client resumes the session from the last sequence.
      socket!.send(JSON.stringify({ op: 7, d: null }));
      for (let i = 0; i < 300 && !received.some((p) => p.op === 6); i++) await Bun.sleep(10);
      expect(received.find((p) => p.op === 6)?.d).toEqual({ token: 'synthetic-token', session_id: 'synthetic-session', seq: 2 });
    } finally {
      await client.stop();
      gateway.stop(true);
    }
  });

  test("the next leader resumes the session the last one saved, so Discord replays what was sent in between", async () => {
    const received: Array<{ op: number; d: any }> = [];
    const gateway = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }));
        },
        message(ws, data) {
          const p = JSON.parse(String(data));
          received.push(p);
          if (p.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 5, d: { session_id: 'saved-session', resume_gateway_url: `ws://localhost:${gateway.port}`, user: { id: BOT }, guilds: [{ id: GUILD }] } }));
          if (p.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: p.d.seq + 1, d: {} }));
        },
      },
    });
    (config as Record<string, unknown>).DISCORD_GATEWAY_URL = `ws://localhost:${gateway.port}`;
    let saved: GatewayState | null = null;
    const store = { load: async () => saved, save: async (s: GatewayState) => void (saved = s) };
    const first = new DiscordGateway(async () => {}, store);
    try {
      await first.start();
      for (let i = 0; i < 200 && !saved; i++) await Bun.sleep(10);
      await first.stop();
      expect(saved).toMatchObject({ sessionId: 'saved-session', seq: 5, botUserId: BOT });

      const next = new DiscordGateway(async () => {}, store);
      await next.start();
      for (let i = 0; i < 200 && !received.some((p) => p.op === 6); i++) await Bun.sleep(10);
      expect(received.filter((p) => p.op === 2)).toHaveLength(1);
      expect(received.find((p) => p.op === 6)?.d).toEqual({ token: 'synthetic-token', session_id: 'saved-session', seq: 5 });
      await next.stop();

      // A session saved too long ago is not tried: the next leader identifies.
      saved = { ...saved!, savedAt: Date.now() - 10 * 60_000 };
      const late = new DiscordGateway(async () => {}, store);
      await late.start();
      for (let i = 0; i < 200 && received.filter((p) => p.op === 2).length < 2; i++) await Bun.sleep(10);
      expect(received.filter((p) => p.op === 2)).toHaveLength(2);
      await late.stop();
    } finally {
      gateway.stop(true);
    }
  });

  test('a fatal close (a wrong token) stops the Gateway for good: no identify loop', async () => {
    let connections = 0;
    const gateway = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          connections += 1;
          ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }));
        },
        message(ws, data) {
          if (JSON.parse(String(data)).op === 2) ws.close(4004, 'Authentication failed');
        },
      },
    });
    (config as Record<string, unknown>).DISCORD_GATEWAY_URL = `ws://localhost:${gateway.port}`;
    const client = new DiscordGateway(async () => {}, { load: async () => null, save: async () => {} });
    try {
      await client.start();
      for (let i = 0; i < 200 && !client.fatal; i++) await Bun.sleep(10);
      expect(client.fatal).toBe(true);
      await client.start();
      await Bun.sleep(100);
      expect(connections).toBe(1);
      expect(client.connected).toBe(false);
    } finally {
      await client.stop();
      gateway.stop(true);
    }
  });

  test('a server that removed the bot loses its installs', async () => {
    const guild = '720000000000000555';
    await saveDiscordInstall({ projectId: OTHER, guildId: guild, guildName: null });
    expect(await forgetDiscordGuild(guild)).toEqual([OTHER]);
    expect(await db.select().from(chatInstalls).where(eq(chatInstalls.platformTeamId, guild))).toEqual([]);
  });
});

describe('edge cases: failures, order and Discord limits', () => {
  test('without the Message Content intent, a message that mentions no one costs no lookup', async () => {
    resetDiscordGatewayCacheForTest();
    expect(await intakeMessage(message({ channel_id: CHANNEL, content: 'lunch?', mentions: [] }), BOT)).toBe('ignored');
    expect(calls).toEqual([]);
  });

  test("after a resume, the first miss in a server reads the server's channels once, not one call per channel", async () => {
    resetDiscordGatewayCacheForTest();
    failures.set(`GET /guilds/${GUILD}/channels`, {
      status: 200,
      body: [channels.get(CHANNEL), channels.get(OTHER_CHANNEL)],
      times: 1,
    });
    expect(await intakeMessage(message({ channel_id: CHANNEL }), BOT)).toBe('stored');
    expect(await intakeMessage(message({ channel_id: OTHER_CHANNEL }), BOT)).toBe('stored');
    expect(routes().filter((r) => r.startsWith('GET '))).toEqual([`GET /guilds/${GUILD}/channels`]);
    await drain();
  });

  test('a lookup Discord could not answer throws for a retry; a channel known from before still routes the message', async () => {
    resetDiscordGatewayCacheForTest();
    const fresh = '730000000000000400';
    channels.set(fresh, { id: fresh, type: 0, guild_id: GUILD, parent_id: null, name: 'ops' });
    failures.set(`GET /guilds/${GUILD}/channels`, { status: 500, body: {}, times: 1 });
    failures.set(`GET /channels/${fresh}`, { status: 503, body: { message: 'unavailable' }, times: 1 });
    await expect(intakeMessage(message({ channel_id: fresh }), BOT)).rejects.toThrow();
    expect(await intakeMessage(message({ channel_id: fresh }), BOT)).toBe('stored');
    // Past the REST answer's 30 minutes, an outage still finds the channel it knew.
    setSystemTime(new Date(Date.now() + 31 * 60_000));
    try {
      failures.set(`GET /channels/${fresh}`, { status: 502, body: {}, times: 1 });
      expect(await intakeMessage(message({ channel_id: fresh }), BOT)).toBe('stored');
    } finally {
      setSystemTime();
    }
    await drain();
  });

  test('a reply to Kortix with its @mention turned off hears, once, that Discord hid it', async () => {
    const thread = '760000000000000500';
    channels.set(thread, { id: thread, type: 11, guild_id: GUILD, parent_id: CHANNEL, name: 'unpinged' });
    const reply = () => message({ channel_id: thread, type: 19, content: '', mentions: [], referenced_message: { author: { id: BOT } } });
    expect(await intakeMessage(reply(), BOT)).toBe('ignored');
    expect(await intakeMessage(reply(), BOT)).toBe('ignored');
    const hints = calls.filter((c) => c.route === `POST /channels/${thread}/messages`);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.body.content).toContain('turn on @mention');
  });

  test("a forward reaches the agent with the forwarded text; a thread's empty message is not answered; an empty DM hears how to start", async () => {
    const forward = message({ channel_id: DM, guild_id: undefined, content: '', mentions: [], message_snapshots: [{ message: { content: 'the forwarded plan' } }] });
    expect(await intakeMessage(forward, BOT)).toBe('stored');
    await drain();
    const sent = JSON.stringify([...created, ...delivered]);
    expect(sent).toContain('(forwarded message)');
    expect(sent).toContain('the forwarded plan');

    const held = '760000000000000510';
    channels.set(held, { id: held, type: 11, guild_id: GUILD, parent_id: CHANNEL, name: 'held' });
    await bindChatThread({ platform: 'discord', workspaceId: GUILD, threadId: held, projectId: PROJECT, sessionId: await newSession() });
    calls.length = 0;
    expect(await intakeMessage(message({ channel_id: held, content: '', mentions: [] }), BOT, { messageContent: true })).toBe('stored');
    await drain();
    expect(routes()).not.toContain(`POST /channels/${held}/messages`);

    calls.length = 0;
    expect(await intakeMessage(message({ channel_id: DM, guild_id: undefined, content: '', mentions: [] }), BOT)).toBe('stored');
    await drain();
    const hint = calls.find((c) => c.route === `POST /channels/${DM}/messages`)?.body.content;
    expect(hint).toContain('Send me what you need');
    expect(hint).not.toContain('Mention me');
  });

  test('an edit counts while its message is fresh: it may add the mention the message lacked', () => {
    const now = Date.now();
    const fresh = message({ channel_id: CHANNEL, edited_timestamp: new Date(now).toISOString() });
    expect(freshEdit(fresh, now)).toBe(true);
    expect(freshEdit({ ...fresh, edited_timestamp: null }, now)).toBe(false);
    expect(freshEdit(fresh, now + 16 * 60_000)).toBe(false);
    // A partial update (an embed unfurled) names no author.
    expect(freshEdit({ ...fresh, author: undefined }, now)).toBe(false);
  });

  test("a thread Discord will not start says why: the server's thread cap, else permissions; a deleted message says nothing", async () => {
    const capped = message({ channel_id: CHANNEL });
    failures.set(`POST /channels/${CHANNEL}/messages/${capped.id}/threads`, { status: 400, body: { message: 'Maximum active threads', code: 160006 }, times: 1 });
    await intakeMessage(capped, BOT);
    const deleted = message({ channel_id: CHANNEL });
    failures.set(`POST /channels/${CHANNEL}/messages/${deleted.id}/threads`, { status: 404, body: { message: 'Unknown Message', code: 10008 }, times: 1 });
    await intakeMessage(deleted, BOT);
    await drain();
    const notices = calls.filter((c) => c.route === `POST /channels/${CHANNEL}/messages`);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body.content).toContain('limit of active threads');
    expect(notices[0]!.body.message_reference?.message_id).toBe(capped.id);
    expect(created).toHaveLength(0);
  });

  test('where the bot may not read the history, a reply goes without its reference instead of failing', async () => {
    failures.set(`POST /channels/${CHANNEL}/messages`, { status: 403, body: { message: 'Cannot reply without permission to read message history', code: 160002 }, times: 1 });
    await intakeMessage(message({ channel_id: CHANNEL, content: `<@${BOT}>` }), BOT);
    await drain();
    const posts = calls.filter((c) => c.route === `POST /channels/${CHANNEL}/messages`);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body.message_reference).toBeDefined();
    expect(posts[1]!.body.message_reference).toBeUndefined();
    expect(posts[1]!.body.content).toContain('Mention me with what you need');
  });

  test('a message whose server was disconnected meanwhile hears it once; a dead event tells its sender', async () => {
    const m = message({ channel_id: CHANNEL });
    const event = {
      id: m.id,
      source: `discord:${GUILD}`,
      type: 'discord.message.created',
      time: new Date().toISOString(),
      subject: m.id,
      projectId: PROJECT,
      data: {
        message: { ...m, attachments: [], mentions: [], stickers: [] },
        // Routed through a server the project no longer has.
        conversation: { guildId: FOREIGN_GUILD, threadId: m.id, settingsId: CHANNEL, direct: false, startThread: true, addressed: true, channelName: 'launch', threadName: null },
        botUserId: BOT,
      },
    };
    await handleDiscordMessage(event as never);
    await handleDiscordMessage({ ...event, id: snowflake() } as never);
    const gone = calls.filter((c) => c.route === `POST /channels/${CHANNEL}/messages`);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.body.content).toContain('not connected to a Kortix workspace any more');

    calls.length = 0;
    await tellDeadDiscordEvent(event as never);
    expect(calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages`)?.body.content).toContain('after several tries');
    const token = 'token-dead';
    await tellDeadDiscordEvent({
      ...event,
      type: 'discord.interaction.created',
      data: { interaction: { id: snowflake(), type: 2, token, channel_id: CHANNEL, user: { id: ALLOWED } }, conversation: event.data.conversation },
    } as never);
    expect(calls.find((c) => c.route === `PATCH /webhooks/${APP}/${token}/messages/@original`)?.body.content).toContain('after several tries');
  });

  test('/connect never reports a channel bound that it did not bind', async () => {
    const conversation = { guildId: FOREIGN_GUILD, threadId: OTHER_CHANNEL, settingsId: OTHER_CHANNEL, direct: false, startThread: false, addressed: true, channelName: 'x', threadName: null };
    expect(await bindDiscordChannel(conversation, PROJECT, ALLOWED)).toBe(false);
  });

  test("/model in a thread of one project whose channel another project holds is refused: only /connect moves a channel", async () => {
    const CH = '730000000000000700';
    const THREAD = '760000000000000700';
    channels.set(CH, { id: CH, type: 0, guild_id: GUILD, parent_id: null, name: 'shared' });
    await saveDiscordInstall({ projectId: OTHER, guildId: GUILD, guildName: null });
    try {
      await db.insert(chatChannelBindings).values({ platform: 'discord', platformTeamId: GUILD, channelId: CH, projectId: OTHER, model: 'other-model' });
      await bindChatThread({ platform: 'discord', workspaceId: GUILD, threadId: THREAD, projectId: PROJECT, sessionId: await newSession() });
      const settings = { platform: 'discord', teamId: GUILD, channelId: CH };
      expect(await ensureChatBinding(settings, PROJECT, { name: null, type: 'channel' }, { keepsOtherProjects: true })).toBe('held');

      const servable = spyOn(defaultModel, 'isModelServableForAccount').mockResolvedValue(true);
      try {
        const body = { ...command('model', { id: THREAD, type: 11, parent_id: CH, name: 'work' }), data: { name: 'model', options: [{ type: 3, name: 'id', value: 'synthetic-model' }] } };
        expect(await (await interact(body)).json()).toEqual({ type: 5 });
        await drain();
        expect(calls.find((c) => c.route === `PATCH /webhooks/${APP}/${body.token}/messages/@original`)?.body.content).toContain('/connect');
      } finally {
        servable.mockRestore();
      }
      const [row] = await db.select().from(chatChannelBindings).where(eq(chatChannelBindings.channelId, CH));
      expect(row).toMatchObject({ projectId: OTHER, model: 'other-model' });
    } finally {
      await releaseDiscordInstall(OTHER);
    }
  });

  test('a DM whose project removed its person routes to the project that allows them, and the stale binding goes', async () => {
    const DM3 = '750000000000000003';
    const GX = '720000000000000003';
    const removed = crypto.randomUUID();
    await db.insert(projects).values({ splitPending: true, projectId: removed, accountId: ACCOUNT, name: 'discord-removed', repoUrl: 'file:///nonexistent/removed.git', metadata: { discord: { allowedUserIds: [] } } });
    await saveDiscordInstall({ projectId: removed, guildId: GX, guildName: null });
    await db.insert(chatChannelBindings).values({ platform: 'discord', platformTeamId: GX, channelId: DM3, projectId: removed, channelType: 'dm' });
    expect(await resolveDiscordRoute({ guildId: null, channelId: DM3, userId: ALLOWED })).toMatchObject({ kind: 'project', projectId: PROJECT });
    const dm = { guildId: GUILD, threadId: DM3, settingsId: DM3, direct: true, startThread: false, addressed: true, channelName: null, threadName: null };
    await claimDiscordChannel(dm, PROJECT, ALLOWED);
    const rows = await db.select({ projectId: chatChannelBindings.projectId }).from(chatChannelBindings).where(eq(chatChannelBindings.channelId, DM3));
    expect(rows).toEqual([{ projectId: PROJECT }]);
    await releaseDiscordInstall(removed);
  });

  test("the agent is told what it cannot read: a voice channel's chat needs a mention, and without the intent history has no text", () => {
    const sender = { user: { id: ALLOWED, username: 'synthetic_sam' } };
    const voice = { guildId: GUILD, threadId: CHANNEL, settingsId: CHANNEL, direct: false, startThread: false, addressed: true, channelName: 'voice', threadName: null };
    const voiceNotes = discordEnvelope(voice, sender, 'hi', snowflake(), true).notes!.join('\n');
    expect(voiceNotes).toContain('mentions you in this channel');
    const thread = { ...voice, threadId: '760000000000000800', threadName: 't' };
    expect(discordEnvelope(thread, sender, 'hi', snowflake(), false).notes!.join('\n')).toContain('`get_messages` returns other people');
    expect(discordEnvelope(thread, sender, 'hi', snowflake(), true).notes!.join('\n')).not.toContain('`get_messages` returns other people');
  });

  test('the agent reads a DM from its start in this project: `after` is declared, and `before` or `around` reach past it', async () => {
    expect(undeclaredChannelArg('discord', 'get_messages', { channel_id: DM, after: snowflake() })).toBeNull();
    expect(undeclaredChannelArg('discord', 'get_messages', { channel_id: DM, around: snowflake() })).toBeNull();
    resetDiscordScopeForTest();
    // The DM is bound to PROJECT (the conversation tests above).
    const after = snowflake();
    expect(await discordCallRefusal({ projectId: PROJECT, actionPath: 'get_messages', args: { channel_id: DM, after } })).toBeNull();
    expect(await discordCallRefusal({ projectId: PROJECT, actionPath: 'get_messages', args: { channel_id: DM, after, before: snowflake() } })).toContain('no `before`');
  });

  test('a change to any field Kortix sets on a command registers the commands again', () => {
    const [first] = discordCommandDefinitions();
    expect(commandShape({ ...first!, id: '1', version: '2' })).toBe(commandShape(first!));
    expect(commandShape({ ...first!, contexts: [0] })).not.toBe(commandShape(first!));
    expect(commandShape({ ...first!, default_member_permissions: '8' })).not.toBe(commandShape(first!));
  });
});

describe('the Gateway under failure', () => {
  /** A fake Gateway: `onIdentify` answers an identify, `onResume` a resume. */
  function fakeGateway(handlers: { onIdentify?: (ws: any, d: any) => void; onResume?: (ws: any, d: any) => void }) {
    const received: Array<{ op: number; d: any }> = [];
    const sockets: any[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.push(ws);
          ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }));
        },
        message(ws, data) {
          const p = JSON.parse(String(data));
          received.push(p);
          if (p.op === 2) handlers.onIdentify?.(ws, p.d);
          if (p.op === 6) handlers.onResume?.(ws, p.d);
        },
      },
    });
    (config as Record<string, unknown>).DISCORD_GATEWAY_URL = `ws://localhost:${server.port}`;
    const ready = (ws: any, s: number, session = 'synthetic-session') =>
      ws.send(JSON.stringify({ op: 0, t: 'READY', s, d: { session_id: session, resume_gateway_url: `ws://localhost:${server.port}`, user: { id: BOT }, guilds: [] } }));
    return { server, received, sockets, ready };
  }
  const until = async (done: () => boolean, ms = 3_000) => {
    for (let i = 0; i < ms / 10 && !done(); i++) await Bun.sleep(10);
  };
  const noStore = { load: async () => null, save: async () => {} };

  test('an intake that fails is tried again; one that fails every try tells the sender to send it again', async () => {
    let tries = 0;
    const m = message({ channel_id: CHANNEL });
    const fake = fakeGateway({
      onIdentify: (ws) => {
        fake.ready(ws, 1);
        ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: m }));
      },
    });
    const flaky = new DiscordGateway(async () => {
      tries += 1;
      if (tries < 3) throw new Error('database unavailable');
    }, noStore, { retryDelaysMs: [0, 0, 0] });
    try {
      await flaky.start();
      await until(() => tries >= 3);
      expect(tries).toBe(3);
      expect(routes()).not.toContain(`POST /channels/${CHANNEL}/messages`);
    } finally {
      await flaky.stop();
    }

    tries = 0;
    const broken = new DiscordGateway(async () => {
      tries += 1;
      throw new Error('database unavailable');
    }, noStore, { retryDelaysMs: [0, 0, 0] });
    try {
      await broken.start();
      await until(() => routes().includes(`POST /channels/${CHANNEL}/messages`));
      expect(tries).toBe(4);
      const told = calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages`);
      expect(told?.body.content).toContain('Send it again');
      expect(told?.body.message_reference?.message_id).toBe(m.id);
    } finally {
      await broken.stop();
      fake.server.stop(true);
    }
  });

  test("one channel's messages are taken in order; a stop waits, then saves the sequence before the first unfinished one and the bot's roles", async () => {
    const ROLE = '780000000000000009';
    const first = message({ channel_id: CHANNEL });
    const second = message({ channel_id: CHANNEL });
    const edit = { ...message({ channel_id: OTHER_CHANNEL }), edited_timestamp: new Date().toISOString() };
    const fake = fakeGateway({
      onIdentify: (ws) => {
        fake.ready(ws, 1);
        ws.send(JSON.stringify({ op: 0, t: 'GUILD_CREATE', s: 2, d: { id: GUILD, channels: [], roles: [{ id: ROLE, tags: { bot_id: BOT } }] } }));
        ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: first }));
        ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: second }));
        ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_UPDATE', s: 5, d: edit }));
      },
    });
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let saved: GatewayState | null = null;
    const client = new DiscordGateway(
      async (m) => {
        order.push(m.id);
        if (m.id === first.id) await held;
      },
      { load: async () => null, save: async (state) => void (saved = state) },
      { stopWaitMs: 50 },
    );
    try {
      await client.start();
      await until(() => order.length >= 2);
      // The edit in another channel ran; the second message of CHANNEL waits for the first.
      expect(order).toEqual([first.id, edit.id]);
      await client.stop();
      expect(saved).toMatchObject({ sessionId: 'synthetic-session', seq: 2, botRoles: { [GUILD]: ROLE } });
    } finally {
      release();
      fake.server.stop(true);
    }
  });

  test('Discord refusing the Message Content intent drops it and keeps the Gateway up; a session Discord dropped identifies again', async () => {
    let identifies = 0;
    const fake = fakeGateway({
      onIdentify: (ws, d) => {
        identifies += 1;
        if (d.intents & 32768) return ws.close(4014, 'Disallowed intent(s)');
        if (identifies === 2) {
          fake.ready(ws, 1);
          // The session timed out on Discord's side: it cannot resume.
          return setTimeout(() => ws.close(4009, 'Session timed out'), 20);
        }
        fake.ready(ws, 1, 'second-session');
      },
    });
    const client = new DiscordGateway(async () => {}, noStore);
    client.messageContent = true;
    try {
      await client.start();
      await until(() => identifies >= 3, 6_000);
      const intents = fake.received.filter((p) => p.op === 2).map((p) => p.d.intents);
      expect(intents).toEqual([4609 + 32768, 4609, 4609]);
      expect(fake.received.some((p) => p.op === 6)).toBe(false);
      expect(client.fatal).toBe(false);
      expect(client.messageContent).toBe(false);
    } finally {
      await client.stop();
      fake.server.stop(true);
    }
  }, 10_000);

  test("no identify once the day's 1,000 are spent: the Gateway waits for Discord's reset", async () => {
    const fake = fakeGateway({});
    failures.set('GET /gateway/bot', { status: 200, body: { session_start_limit: { total: 1000, remaining: 0, reset_after: 3_600_000 } }, times: 1 });
    const client = new DiscordGateway(async () => {}, noStore);
    try {
      await client.start();
      await Bun.sleep(150);
      expect(fake.sockets).toHaveLength(0);
      expect(client.connected).toBe(true);
    } finally {
      await client.stop();
      fake.server.stop(true);
    }
  });
});

describe('the Channels page', () => {
  test('a DM is listed under its person, not as "direct message"', async () => {
    const dm = '750000000000000009';
    expect(await intakeMessage(message({ channel_id: dm, guild_id: undefined, content: 'hello from a new DM', mentions: [] }), BOT)).toBe('stored');
    await drain();
    const [row] = await db.select({ name: chatChannelBindings.channelName, type: chatChannelBindings.channelType }).from(chatChannelBindings).where(eq(chatChannelBindings.channelId, dm));
    expect(row).toEqual({ name: 'Sam (@synthetic_sam)', type: 'dm' });
  });
});

describe('the working mark', () => {
  const HOURGLASS = encodeURIComponent('⏳');
  const CHECK = encodeURIComponent('✅');
  const marked = (id: string, me = true) => ({ id, reactions: [{ me, count: 1, emoji: { name: '⏳', id: null } }] });

  test("a message handed to the agent shows ⏳; when the session goes idle, ✅ replaces it on the thread's starter and on a follow-up", async () => {
    const m = message({ channel_id: CHANNEL });
    await intakeMessage(m, BOT);
    await drain();
    expect(routes()).toContain(`PUT /channels/${CHANNEL}/messages/${m.id}/reactions/${HOURGLASS}/@me`);
    const [thread] = await db.select({ sessionId: chatThreads.sessionId }).from(chatThreads).where(eq(chatThreads.threadId, m.id));

    // Discord lists the bot's own ⏳ (`me`) on a follow-up in the thread; someone else's ⏳ is not Kortix's.
    const followUp = snowflake();
    failures.set(`GET /channels/${m.id}/messages`, { status: 200, body: [marked(followUp), marked(snowflake(), false)], times: 1 });
    failures.set(`GET /channels/${CHANNEL}/messages/${m.id}`, { status: 200, body: marked(m.id), times: 1 });
    calls.length = 0;
    await settleSessionChat(thread!.sessionId, 'done');
    expect(routes().filter((r) => !r.startsWith('GET '))).toEqual([
      `DELETE /channels/${m.id}/messages/${followUp}/reactions/${HOURGLASS}/@me`,
      `PUT /channels/${m.id}/messages/${followUp}/reactions/${CHECK}/@me`,
      `DELETE /channels/${CHANNEL}/messages/${m.id}/reactions/${HOURGLASS}/@me`,
      `PUT /channels/${CHANNEL}/messages/${m.id}/reactions/${CHECK}/@me`,
    ]);

    // A failed or stopped run clears the mark and claims nothing.
    failures.set(`GET /channels/${m.id}/messages`, { status: 200, body: [marked(followUp)], times: 1 });
    calls.length = 0;
    await settleSessionChat(thread!.sessionId, 'failed');
    expect(routes().filter((r) => !r.startsWith('GET '))).toEqual([`DELETE /channels/${m.id}/messages/${followUp}/reactions/${HOURGLASS}/@me`]);
  });

  test('a message that never reached a session loses its ⏳ with the notice that says so, a thread start included', async () => {
    const started = snowflake();
    // The thread Kortix started on the mention: Discord names its parent.
    channels.set(started, { id: started, type: 11, guild_id: GUILD, parent_id: CHANNEL, name: 'started' });
    failures.set(`GET /channels/${CHANNEL}/messages/${started}`, { status: 200, body: marked(started), times: 1 });
    await discordPort.notify(
      { platform: 'discord', workspaceId: GUILD, threadId: started, projectId: PROJECT, messageId: started },
      { kind: 'create_in_flight' },
    );
    expect(routes()).toContain(`DELETE /channels/${CHANNEL}/messages/${started}/reactions/${HOURGLASS}/@me`);
    expect(routes().some((r) => r.includes(CHECK))).toBe(false);
  });
});
