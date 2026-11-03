/**
 * Real-Postgres contract for the Discord channel. Every case enters where
 * Discord enters: the interactions webhook (the real route, signed with a test
 * Ed25519 key), the Gateway intake (`intakeMessage`, and the Gateway client
 * against a fake WebSocket), and the job worker that runs the stored events.
 * Discord's REST API is a local fake that records each call. The session
 * lifecycle is cut at `createSession` / `deliverThroughQueue`. Synthetic ids.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { accounts, chatChannelBindings, chatInstalls, chatThreads, jobQueue, projectSessions, projects } from '@kortix/db';
import { and, eq, like } from 'drizzle-orm';
import { config } from '../../config';
import { discordCallRefusal } from '../../connectors/channel-discord-scope';
import { db } from '../../shared/db';
import { runJobBatch } from '../../shared/job-queue';
import { resetChannelLifecycleForTest, setChannelLifecycleForTest } from '../core/conversation';
import { bindChatThread } from '../core/threads';
import { channelAppWebhookRoutes } from '../inbound/webhook-routes';
import { snowflakeSequence } from './api';
import { DiscordGateway, discordIntents, intakeMessage, type GatewayMessage } from './gateway';
import { discordInbound } from './inbound';
import { forgetDiscordGuild, loadDiscordInstall, saveDiscordInstall } from './installs';
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
    return Response.json({ id: snowflake() });
  },
});
const routes = () => calls.map((c) => c.route);

/** The fields of the session create the core asked for. */
const created: Array<Record<string, any>> = [];
const delivered: Array<Record<string, any>> = [];

async function newSession(projectId = PROJECT) {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({ sessionId, accountId: ACCOUNT, projectId, branchName: sessionId, createdBy: ACTOR });
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
  });
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'discord-test' });
  for (const [projectId, name] of [[PROJECT, 'discord-main'], [OTHER, 'discord-other']] as const) {
    await db.insert(projects).values({
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
      const sessionId = await newSession(input.project.projectId);
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

  test('a command from someone the project does not allow is refused, only to them', async () => {
    const body = command('status', { id: CHANNEL, type: 0, name: 'launch' }, STRANGER);
    expect(await (await interact(body)).json()).toEqual({ type: 5 });
    await drain();
    const drawn = calls.find((c) => c.route === `PATCH /webhooks/${APP}/${body.token}/messages/@original`);
    expect(drawn?.body.content).toContain(`user ID ${STRANGER}`);
  });

  test('a server no project has hears where to connect it, and nothing is stored', async () => {
    const body = { ...command('status', { id: FOREIGN_CHANNEL, type: 0 }), guild_id: FOREIGN_GUILD };
    const reply = (await (await interact(body)).json()) as { type: number; data: { content: string; flags: number } };
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toContain('not connected to a Kortix project');
    expect(await db.select().from(jobQueue).where(eq(jobQueue.jobKey, `discord:${FOREIGN_GUILD}:${body.id}`))).toEqual([]);
  });
});

describe('a conversation', () => {
  test('a mention in a text channel starts a thread on the message and one session bound to it', async () => {
    const m = message({ channel_id: CHANNEL });
    expect(await intakeMessage(m, BOT)).toBe('stored');
    await drain();

    expect(calls.find((c) => c.route === `POST /channels/${CHANNEL}/messages/${m.id}/threads`)?.body.auto_archive_duration).toBe(10080);
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
    expect(await refusal({ channel_id: OTHER_CHANNEL })).toContain('not a conversation of this Kortix project');
    expect(await refusal({ channel_id: FOREIGN_CHANNEL })).toContain('not a conversation of this Kortix project');
    expect(await refusal({ channel_id: 'general' })).toContain('one Discord channel id');
    expect(await refusal({ channel_id: own, message_reference: { message_id: own, channel_id: FOREIGN_CHANNEL } })).toContain('same channel');
    expect(await refusal({ channel_id: own, message_reference: { message_id: own, type: 1 } })).toContain('does not forward');

    // The session the thread started acts only in its thread.
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.threadId, own));
    expect(await refusal({ channel_id: own }, thread!.sessionId)).toBeNull();
    expect(await refusal({ channel_id: CHANNEL }, thread!.sessionId)).toContain(`answers Discord conversation ${own} only`);
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
    const client = new DiscordGateway(async (m, botUserId) => void seen.push(`${botUserId}:${m.channel_id}`));
    try {
      client.start();
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
      client.stop();
      gateway.stop(true);
    }
  });

  test('a server that removed the bot loses its installs', async () => {
    const guild = '720000000000000555';
    await saveDiscordInstall({ projectId: OTHER, guildId: guild, guildName: null });
    expect(await forgetDiscordGuild(guild)).toEqual([OTHER]);
    expect(await db.select().from(chatInstalls).where(eq(chatInstalls.workspaceId, guild))).toEqual([]);
  });
});
