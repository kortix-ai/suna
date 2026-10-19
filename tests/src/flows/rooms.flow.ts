/**
 * ROOM-1..7 — Conversations between agent sessions and people (flag `agent_rooms`).
 * Contract: tests/spec/end-to-end.md §35. Pure rules (mentions, the agent-chain
 * pause) are pinned in apps/api/src/projects/rooms/envelope.test.ts; the text a
 * member session receives in packages/shared/src/room-prompt.test.ts.
 */
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { withDb } from '../fixtures/chat';
import { CliSandbox, type CliResult } from '../fixtures/cli';
import { bindDatabaseSessionCredential, createDatabaseSession, setDatabaseProjectFeature } from '../fixtures/database-project';

const ROOMS = '/v1/projects/:projectId/rooms';
const DIRECT = '/v1/projects/:projectId/rooms/direct';
const PEOPLE = '/v1/projects/:projectId/rooms/people';
const ROOM = '/v1/projects/:projectId/rooms/:roomId';
const MESSAGES = '/v1/projects/:projectId/rooms/:roomId/messages';
const READ = '/v1/projects/:projectId/rooms/:roomId/read';
const SESSION_MEMBER = '/v1/projects/:projectId/rooms/:roomId/members/sessions/:sessionId';
const PERSON_MEMBER = '/v1/projects/:projectId/rooms/:roomId/members/people/:userId';
const SESSION_ROOMS = '/v1/projects/:projectId/sessions/:sessionId/rooms';
const AS_SESSION = '/v1/projects/:projectId/sessions/:sessionId/rooms/:roomId';
const AS_SESSION_MESSAGES = '/v1/projects/:projectId/sessions/:sessionId/rooms/:roomId/messages';
const PROMPTS = '/v1/projects/:projectId/sessions/:sessionId/prompts';

type Delivery = { member: string; session_id: string | null; user_id: string | null; state: string; reason?: string };
type PostResult = { message: { seq: number; sender_kind: string; sender_session_id: string | null }; deliveries: Delivery[]; paused: boolean };
type Conversation = { room_id: string; kind: string; unread: number; peer: { kind: string; label: string } | null };

function delivery(result: PostResult, id: string): Delivery {
  const found = result.deliveries.find((d) => d.session_id === id || d.user_id === id);
  if (!found) throw new Error(`no delivery verdict for ${id}: ${JSON.stringify(result.deliveries)}`);
  return found;
}

/** The room events owed to a session: the durable rows a post writes, never a person's queued prompt. */
async function roomEvents(ctx: FlowContext, sessionId: string): Promise<string[]> {
  return withDb(ctx, async (db) => (await db.query<{ text: string }>(
    `SELECT payload->>'text' AS text FROM kortix.session_lifecycle_commands
      WHERE session_id = $1 AND source = 'system:room-message' ORDER BY created_at`,
    [sessionId],
  )).rows.map((row) => row.text));
}

/** A project PAT bound to `sessionId`: the credential a session's agent runs the CLI with. */
async function sessionToken(ctx: FlowContext, projectId: string, accountId: string, sessionId: string) {
  const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('room') }, { params: { projectId } });
  minted.status(201);
  const token = minted.json<{ token_id: string; secret_key: string }>();
  await bindDatabaseSessionCredential(ctx.env, { tokenId: token.token_id, commandId: crypto.randomUUID(), sessionId, accountId, projectId });
  return token;
}

async function dropToken(ctx: FlowContext, projectId: string, tokenId: string) {
  await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', { params: { projectId, tokenId } }).catch(() => {});
}

function ok(result: CliResult, what: string, code = 0): CliResult {
  if (result.exitCode !== code) throw new Error(`${what}: exit ${result.exitCode} (want ${code}): ${result.all.slice(0, 800)}`);
  return result;
}

flow(
  'ROOM-1',
  {
    domain: 'rooms',
    requires: ['database'],
    routes: ['GET /v1/projects/:projectId/rooms', 'POST /v1/projects/:projectId/rooms', 'PATCH /v1/projects/:projectId/rooms/:roomId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const p = { projectId: project.id };

    await ctx.step('flag agent_rooms off (the default): list and create → 403 feature_disabled', async () => {
      (await owner.get(ROOMS, { params: p })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.post(ROOMS, { name: 'dev' }, { params: p })).status(403).body().has('$.code', 'feature_disabled');
    });
    await setDatabaseProjectFeature(ctx.env, project.id, 'agent_rooms', true);

    let roomId = '';
    await ctx.step('owner creates platinum/dev → 201 kind room; the same name again → 200 with the same room_id', async () => {
      const created = await owner.post(ROOMS, { name: 'platinum/dev', topic: 'who is touching dev' }, { params: p });
      created.status(201).body().has('$.name', 'platinum/dev').has('$.kind', 'room').has('$.last_seq', 0);
      roomId = created.json<{ room_id: string }>().room_id;
      (await owner.post(ROOMS, { name: 'platinum/dev' }, { params: p })).status(200).body().has('$.room_id', roomId);
    });
    await ctx.step('a name with an uppercase letter or a leading dash → 400', async () => {
      (await owner.post(ROOMS, { name: 'Dev' }, { params: p })).status(400);
      (await owner.post(ROOMS, { name: '-dev' }, { params: p })).status(400);
    });
    await ctx.step('list and ?name= return the room with member_count 0; a project member reads it too', async () => {
      (await owner.get(ROOMS, { params: p })).status(200).body().has('$.rooms[0].room_id', roomId).has('$.rooms[0].member_count', 0);
      (await ctx.client.as(member).get(`${ROOMS}?name=platinum%2Fdev`, { params: p })).status(200).body().has('$.rooms[0].room_id', roomId);
      (await owner.get(`${ROOMS}?name=nope`, { params: p })).status(200).body().has('$.rooms.length', 0);
    });
    await ctx.step('NONMEMBER → 403; ANON → 401', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).get(ROOMS, { params: p })).status(403);
      (await ctx.client.as(ctx.P.ANON).get(ROOMS, { params: p })).status(401);
    });
    await ctx.step('a member who did not create the room may set its topic but not archive it → 403', async () => {
      (await ctx.client.as(member).patch(ROOM, { topic: 'dev deploys' }, { params: { ...p, roomId } })).status(200).body().has('$.topic', 'dev deploys');
      (await ctx.client.as(member).patch(ROOM, { archived: true }, { params: { ...p, roomId } })).status(403);
    });
    await ctx.step('the creator archives it: the default list leaves it out, ?archived=true lists it', async () => {
      (await owner.patch(ROOM, { archived: true }, { params: { ...p, roomId } })).status(200);
      (await owner.get(ROOMS, { params: p })).status(200).body().has('$.rooms.length', 0);
      (await owner.get(`${ROOMS}?archived=true`, { params: p })).status(200).body().has('$.rooms[0].room_id', roomId);
    });
  },
);

flow(
  'ROOM-2',
  {
    domain: 'rooms',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/rooms/:roomId',
      'GET /v1/projects/:projectId/rooms/:roomId/messages',
      'POST /v1/projects/:projectId/rooms/:roomId/messages',
      'PUT /v1/projects/:projectId/rooms/:roomId/members/sessions/:sessionId',
      'DELETE /v1/projects/:projectId/rooms/:roomId/members/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    await setDatabaseProjectFeature(ctx.env, project.id, 'agent_rooms', true);
    const owner = ctx.client.as(ctx.P.OWNER);
    const p = { projectId: project.id };
    const seed = async (visibility: 'private' | 'project', name: string) => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility, metadata: { name },
      });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    const builder = await seed('project', 'Builder');
    const reviewer = await seed('project', 'Reviewer');
    const secret = await seed('private', 'Private work');
    const roomId = (await owner.post(ROOMS, { name: 'dev' }, { params: p })).status(201).json<{ room_id: string }>().room_id;
    const r = { ...p, roomId };

    await ctx.step('owner puts Builder (notify all) and Reviewer (notify mentions) in the room → 200', async () => {
      (await owner.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: builder } })).status(200).body().has('$.notify', 'all').has('$.kind', 'session');
      (await owner.put(SESSION_MEMBER, { notify: 'mentions' }, { params: { ...r, sessionId: reviewer } })).status(200).body().has('$.notify', 'mentions');
    });
    await ctx.step("a member cannot put the owner's private session in → 404; an unknown session → 404", async () => {
      (await ctx.client.as(member).put(SESSION_MEMBER, {}, { params: { ...r, sessionId: secret } })).status(404);
      (await owner.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: crypto.randomUUID() } })).status(404);
    });
    await ctx.step('GET the room lists both members', async () => {
      (await owner.get(ROOM, { params: r })).status(200).body().has('$.members.length', 2).has('$.member_count', 2);
    });

    await ctx.step('owner posts → #1 queued for Builder as a room event, NOT as a queued prompt; Reviewer skipped not_mentioned', async () => {
      const res = await owner.post(MESSAGES, { text: 'who blocked dev?' }, { params: r });
      res.status(201).body().has('$.message.seq', 1).has('$.message.sender_kind', 'member').has('$.paused', false);
      const result = res.json<PostResult>();
      if (delivery(result, builder).state !== 'queued') throw new Error('Builder not queued');
      if (delivery(result, reviewer).reason !== 'not_mentioned') throw new Error('Reviewer not skipped as not_mentioned');
      const events = await roomEvents(ctx, builder);
      if (events.length !== 1 || !events[0]!.startsWith('[room dev · #1 · from ') || !events[0]!.includes('kortix rooms send dev --reply-to 1')) {
        throw new Error(`room event for Builder: ${JSON.stringify(events)}`);
      }
      (await owner.get(PROMPTS, { params: { ...p, sessionId: builder } })).status(200).body().has('$.prompts.length', 0);
    });
    await ctx.step('a message that @-mentions Reviewer by its id prefix reaches Reviewer', async () => {
      const res = await owner.post(MESSAGES, { text: `@${reviewer.slice(0, 8)} please look`, reply_to: 1 }, { params: r });
      res.status(201).body().has('$.message.seq', 2);
      if (delivery(res.json<PostResult>(), reviewer).state !== 'queued') throw new Error('Reviewer not queued on mention');
    });
    await ctx.step('reply_to beyond the newest seq → 400; empty text → 400', async () => {
      (await owner.post(MESSAGES, { text: 'x', reply_to: 99 }, { params: r })).status(400);
      (await owner.post(MESSAGES, { text: '' }, { params: r })).status(400);
    });
    await ctx.step('messages read newest-last; after=1 reads forward', async () => {
      (await owner.get(MESSAGES, { params: r })).status(200).body().has('$.messages.length', 2).has('$.last_seq', 2).has('$.messages[1].reply_to_seq', 1);
      (await owner.get(`${MESSAGES}?after=1`, { params: r })).status(200).body().has('$.messages.length', 1).has('$.messages[0].seq', 2);
    });
    await ctx.step('NONMEMBER cannot read or post → 403', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).get(MESSAGES, { params: r })).status(403);
      (await ctx.client.as(ctx.P.NONMEMBER).post(MESSAGES, { text: 'hi' }, { params: r })).status(403);
    });
    await ctx.step('take Reviewer out → removed:true; again → removed:false', async () => {
      (await owner.del(SESSION_MEMBER, { params: { ...r, sessionId: reviewer } })).status(200).body().has('$.removed', true);
      (await owner.del(SESSION_MEMBER, { params: { ...r, sessionId: reviewer } })).status(200).body().has('$.removed', false);
    });
    await ctx.step('an archived room takes no message → 409 and no member → 409', async () => {
      (await owner.patch(ROOM, { archived: true }, { params: r })).status(200);
      (await owner.post(MESSAGES, { text: 'late' }, { params: r })).status(409);
      (await owner.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: reviewer } })).status(409);
    });
  },
);

flow(
  'ROOM-3',
  {
    domain: 'rooms',
    requires: ['database'],
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId/rooms', 'POST /v1/projects/:projectId/rooms/:roomId/messages'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    await setDatabaseProjectFeature(ctx.env, project.id, 'agent_rooms', true);
    const owner = ctx.client.as(ctx.P.OWNER);
    const p = { projectId: project.id };
    const seed = async (name: string) => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'project', metadata: { name },
      });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    const alpha = await seed('Alpha');
    const beta = await seed('Beta');
    const roomId = (await owner.post(ROOMS, { name: 'pair' }, { params: p })).status(201).json<{ room_id: string }>().room_id;
    const r = { ...p, roomId };
    for (const sessionId of [alpha, beta]) (await owner.put(SESSION_MEMBER, {}, { params: { ...r, sessionId } })).status(200);
    const token = await sessionToken(ctx, project.id, team.id, alpha);
    const asAlpha = ctx.client.withBearer(token.secret_key, 'Alpha session credential');

    try {
      await ctx.step("Alpha's own token lists Alpha's conversations", async () => {
        (await asAlpha.get(SESSION_ROOMS, { params: { ...p, sessionId: alpha } })).status(200).body().has('$.rooms[0].name', 'pair').has('$.rooms[0].notify', 'all');
      });
      await ctx.step('Alpha posts → sender_kind session; Beta queued, Alpha skipped as the sender', async () => {
        const res = await asAlpha.post(MESSAGES, { text: 'Beta: I re-ran deploy-dev' }, { params: r });
        res.status(201).body().has('$.message.sender_kind', 'session').has('$.message.sender_session_id', alpha);
        const result = res.json<PostResult>();
        if (delivery(result, beta).state !== 'queued') throw new Error('Beta not queued');
        if (delivery(result, alpha).reason !== 'sender') throw new Error('Alpha not skipped as sender');
      });
      await ctx.step('after 20 consecutive session messages the next one is stored but paused; a person posting resumes', async () => {
        let last: PostResult | null = null;
        for (let i = 2; i <= 21; i += 1) {
          const res = await asAlpha.post(MESSAGES, { text: `step ${i}` }, { params: r });
          res.status(201);
          last = res.json<PostResult>();
        }
        if (!last?.paused || delivery(last, beta).reason !== 'agent_chain') throw new Error(`21st session message not paused: ${JSON.stringify(last)}`);
        (await owner.post(MESSAGES, { text: 'carry on' }, { params: r })).status(201).body().has('$.paused', false);
        (await asAlpha.post(MESSAGES, { text: 'ok' }, { params: r })).status(201).body().has('$.paused', false);
      });
      await ctx.step('Alpha takes itself out with its own token → removed:true', async () => {
        (await asAlpha.del(SESSION_MEMBER, { params: { ...r, sessionId: alpha } })).status(200).body().has('$.removed', true);
      });
    } finally {
      await dropToken(ctx, project.id, token.token_id);
    }
  },
);

flow(
  'ROOM-4',
  {
    domain: 'rooms',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/rooms/:roomId/messages',
      'POST /v1/projects/:projectId/sessions/:sessionId/rooms/:roomId/messages',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/rooms/:roomId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const home = await team.project();
    const other = await team.project();
    await setDatabaseProjectFeature(ctx.env, home.id, 'agent_rooms', true);
    const owner = ctx.client.as(ctx.P.OWNER);
    const gamma = await createDatabaseSession(ctx.env, {
      projectId: other.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'project', metadata: { name: 'Gamma' },
    });
    ctx.track('session', gamma, { projectId: other.id });
    const roomId = (await owner.post(ROOMS, { name: 'platinum/dev' }, { params: { projectId: home.id } })).status(201).json<{ room_id: string }>().room_id;
    const r = { projectId: home.id, roomId };

    await ctx.step("a session of another project joins only while that project's flag is on too", async () => {
      (await owner.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: gamma } })).status(403).body().has('$.code', 'feature_disabled');
      await setDatabaseProjectFeature(ctx.env, other.id, 'agent_rooms', true);
      (await owner.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: gamma } })).status(200).body().has('$.project_id', other.id);
    });
    const token = await sessionToken(ctx, other.id, team.id, gamma);
    const asGamma = ctx.client.withBearer(token.secret_key, 'Gamma session credential');
    const g = { projectId: other.id, sessionId: gamma, roomId };
    try {
      await ctx.step("Gamma's token, bound to its own project, cannot list the home project's rooms → 403", async () => {
        (await asGamma.get(ROOMS, { params: { projectId: home.id } })).status(403);
      });
      await ctx.step("Gamma finds the room through its own session's conversations, with the room's project_id", async () => {
        (await asGamma.get(SESSION_ROOMS, { params: { projectId: other.id, sessionId: gamma } }))
          .status(200).body().has('$.rooms[0].room_id', roomId).has('$.rooms[0].project_id', home.id);
      });
      await ctx.step('the owner posts → Gamma queued; Gamma reads and answers as itself under its own project', async () => {
        const res = await owner.post(MESSAGES, { text: 'did you block dev?' }, { params: r });
        res.status(201);
        if (delivery(res.json<PostResult>(), gamma).state !== 'queued') throw new Error('Gamma not queued');
        const events = await roomEvents(ctx, gamma);
        if (!events[0]?.includes(`--project ${home.id}`)) throw new Error(`Gamma's room event lacks --project: ${events[0]}`);
        (await asGamma.get(AS_SESSION_MESSAGES, { params: g })).status(200).body().has('$.messages[0].text', 'did you block dev?');
        (await asGamma.post(AS_SESSION_MESSAGES, { text: 'yes, reverting now', reply_to: 1 }, { params: g }))
          .status(201).body().has('$.message.sender_session_id', gamma).has('$.message.reply_to_seq', 1);
      });
      await ctx.step("the session routes answer only the session's own credential → owner 403; a room Gamma is not in → 404", async () => {
        (await owner.get(AS_SESSION_MESSAGES, { params: g })).status(403);
        const lonely = (await owner.post(ROOMS, { name: 'lonely' }, { params: { projectId: home.id } })).status(201).json<{ room_id: string }>().room_id;
        (await asGamma.get(AS_SESSION_MESSAGES, { params: { ...g, roomId: lonely } })).status(404);
      });
      await ctx.step("Gamma's project turns the flag off: a post skips Gamma with reason flag_off", async () => {
        await setDatabaseProjectFeature(ctx.env, other.id, 'agent_rooms', false);
        const res = await owner.post(MESSAGES, { text: 'still there?' }, { params: r });
        res.status(201);
        if (delivery(res.json<PostResult>(), gamma).reason !== 'flag_off') throw new Error('Gamma not skipped as flag_off');
      });
      await ctx.step('Gamma leaves through its session route → removed:true (flag back on)', async () => {
        await setDatabaseProjectFeature(ctx.env, other.id, 'agent_rooms', true);
        (await asGamma.del(AS_SESSION, { params: g })).status(200).body().has('$.removed', true);
        (await owner.get(ROOM, { params: r })).status(200).body().has('$.members.length', 0);
      });
    } finally {
      await dropToken(ctx, other.id, token.token_id);
    }
  },
);

flow(
  'ROOM-5',
  { domain: 'rooms', requires: ['database'], routes: [] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const home = await team.project();
    const other = await team.project();
    for (const project of [home, other]) await setDatabaseProjectFeature(ctx.env, project.id, 'agent_rooms', true);
    const seed = async (projectId: string, name: string) => {
      const id = await createDatabaseSession(ctx.env, {
        projectId, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'project', metadata: { name },
      });
      ctx.track('session', id, { projectId });
      return id;
    };
    const alpha = await seed(home.id, 'Alpha');
    const gamma = await seed(other.id, 'Gamma');
    const alphaToken = await sessionToken(ctx, home.id, team.id, alpha);
    const gammaToken = await sessionToken(ctx, other.id, team.id, gamma);
    const sandbox = new CliSandbox('rooms');
    const person = { KORTIX_TOKEN: await ctx.fixtures.pat({ name: ctx.fixtures.name('room5') }), KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: home.id };
    const asAlpha = { KORTIX_TOKEN: alphaToken.secret_key, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: home.id, KORTIX_SESSION_ID: alpha };
    const asGamma = { KORTIX_TOKEN: gammaToken.secret_key, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: other.id, KORTIX_SESSION_ID: gamma };
    const run = (env: Record<string, string>, args: string[], stdin?: string) => sandbox.run(args, { env, stdin });
    try {
      await ctx.step('`rooms join dev --session <alpha> --topic … --json` creates the room and the membership → exit 0', async () => {
        const out = JSON.parse(ok(await run(person, ['rooms', 'join', 'dev', '--session', alpha, '--topic', 'dev deploys', '--json']), 'join').stdout);
        if (!out.created || out.room.name !== 'dev' || out.member.notify !== 'all') throw new Error(`unexpected join: ${JSON.stringify(out)}`);
      });
      await ctx.step('the person joins too (`rooms join dev`, no --session) → a person member', async () => {
        const out = JSON.parse(ok(await run(person, ['rooms', 'join', 'dev', '--json']), 'self join').stdout);
        if (out.member.kind !== 'person') throw new Error(JSON.stringify(out));
      });
      await ctx.step('`rooms send dev "…" --json` as the person → seq 1, queued for Alpha', async () => {
        const out = JSON.parse(ok(await run(person, ['rooms', 'send', 'dev', 'who blocked dev?', '--json']), 'send').stdout);
        if (out.message.seq !== 1 || !out.deliveries.some((d: Delivery) => d.session_id === alpha && d.state === 'queued')) throw new Error(JSON.stringify(out));
      });
      await ctx.step('inside Alpha: `rooms read dev --json` sees #1; a reply on stdin with --reply-to 1 → the person has 1 unread', async () => {
        const read = JSON.parse(ok(await run(asAlpha, ['rooms', 'read', 'dev', '--json']), 'read').stdout);
        if (read.messages[0]?.text !== 'who blocked dev?') throw new Error(JSON.stringify(read));
        const sent = JSON.parse(ok(await run(asAlpha, ['rooms', 'send', 'dev', '--reply-to', '1', '--json'], 'I did, reverting'), 'reply').stdout);
        if (sent.message.sender_session_id !== alpha || sent.message.reply_to_seq !== 1) throw new Error(JSON.stringify(sent));
        const mine = JSON.parse(ok(await run(person, ['rooms', 'ls', '--mine', '--json']), 'ls mine').stdout);
        if (mine.rooms.find((r: Conversation) => r.kind === 'room')?.unread !== 1) throw new Error(`unread not 1: ${JSON.stringify(mine)}`);
      });
      await ctx.step("the person: `rooms next dev --after 1 --json` prints Alpha's reply and marks it read; nothing newer → exit 4", async () => {
        const next = JSON.parse(ok(await run(person, ['rooms', 'next', 'dev', '--after', '1', '--timeout', '5', '--json']), 'next').stdout);
        if (next.message?.text !== 'I did, reverting') throw new Error(JSON.stringify(next));
        const mine = JSON.parse(ok(await run(person, ['rooms', 'ls', '--mine', '--json']), 'ls mine').stdout);
        if (mine.rooms.find((r: Conversation) => r.kind === 'room')?.unread !== 0) throw new Error(`unread not 0: ${JSON.stringify(mine)}`);
        ok(await run(person, ['rooms', 'next', 'dev', '--timeout', '2']), 'next timeout', 4);
      });
      await ctx.step('a session of another project, put in by the person, answers with plain `rooms send dev` → its session route', async () => {
        ok(await run(person, ['rooms', 'join', 'dev', '--session', gamma, '--json']), 'join gamma');
        const sent = JSON.parse(ok(await run(asGamma, ['rooms', 'send', 'dev', 'not me, I was on staging', '--json']), 'gamma send').stdout);
        if (sent.message.sender_session_id !== gamma) throw new Error(JSON.stringify(sent));
        if (!sent.deliveries.some((d: Delivery) => d.session_id === alpha && d.state === 'queued')) throw new Error("Alpha did not get Gamma's message");
        const left = JSON.parse(ok(await run(asGamma, ['rooms', 'leave', 'dev', '--json']), 'gamma leave').stdout);
        if (left.removed !== true) throw new Error(JSON.stringify(left));
      });
      await ctx.step('`kortix dm <alpha prefix> "…"` as the person opens a direct conversation; Alpha `kortix dm <email>` answers it', async () => {
        const out = JSON.parse(ok(await run(person, ['dm', alpha.slice(0, 8), 'What did migration 0049 change?', '--json']), 'dm alpha').stdout);
        if (!out.deliveries.some((d: Delivery) => d.session_id === alpha && d.state === 'queued')) throw new Error(JSON.stringify(out));
        const back = JSON.parse(ok(await run(asAlpha, ['dm', ctx.P.OWNER.email!, 'It added an index, nothing else.', '--json']), 'dm owner').stdout);
        if (!back.deliveries.some((d: Delivery) => d.user_id === ctx.P.OWNER.userId)) throw new Error(JSON.stringify(back));
        const mine = JSON.parse(ok(await run(person, ['rooms', 'ls', '--mine', '--json']), 'ls mine').stdout);
        const direct = mine.rooms.find((r: Conversation) => r.kind === 'direct');
        if (direct?.unread !== 1 || direct?.peer?.kind !== 'session') throw new Error(`direct conversation: ${JSON.stringify(mine)}`);
      });
      await ctx.step('`rooms ls --json` lists dev with 2 members; `rooms info dev` names Alpha and the person', async () => {
        const ls = JSON.parse(ok(await run(person, ['rooms', 'ls', '--json']), 'ls').stdout);
        const dev = ls.rooms.find((room: { name: string }) => room.name === 'dev');
        if (dev?.member_count !== 2 || dev?.last_seq !== 3) throw new Error(JSON.stringify(ls));
        const info = ok(await run(person, ['rooms', 'info', 'dev']), 'info').stdout;
        if (!info.includes('Alpha') || !info.includes('person')) throw new Error(info);
      });
      await ctx.step('usage errors exit 2 without a request: unknown subcommand, bad --notify, send with no text, dm with no target', async () => {
        ok(await run(person, ['rooms', 'bogus']), 'bogus', 2);
        ok(await run(person, ['rooms', 'join', 'dev', '--notify', 'loud']), 'notify', 2);
        ok(await run(person, ['rooms', 'send', 'dev'], ''), 'empty send', 2);
        ok(await run(person, ['dm', 'not-an-id-or-email', 'x']), 'dm target', 2);
      });
    } finally {
      sandbox.dispose();
      await dropToken(ctx, home.id, alphaToken.token_id);
      await dropToken(ctx, other.id, gammaToken.token_id);
    }
  },
);

const GOVERNED_MANIFEST = [
  'kortix_version: 2',
  'project:',
  '  name: ke2e-rooms',
  'default_agent: talker',
  'agents:',
  '  talker:',
  '    kortix_permissions: [project.session.read, project.room.read, project.room.write]',
  '  reader:',
  '    kortix_permissions: [project.session.read, project.room.read]',
  '  mute:',
  '    kortix_permissions: [project.session.read]',
  '',
].join('\n');

flow(
  'ROOM-6',
  { domain: 'rooms', requires: ['database'], timeoutMs: 180_000, routes: [] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
    try {
      await world.setFeature('agent_rooms', true);
      await world.writeManifest(GOVERNED_MANIFEST, 'ke2e: rooms agents');
      const talker = await world.mintAgentSession({ agent: 'talker', launcher: ctx.P.OWNER, visibility: 'project' });
      const reader = await world.mintAgentSession({ agent: 'reader', launcher: ctx.P.OWNER, visibility: 'project' });
      const mute = await world.mintAgentSession({ agent: 'mute', launcher: ctx.P.OWNER, visibility: 'project' });
      const owner = ctx.client.as(ctx.P.OWNER);
      const p = { projectId: project.id };
      const roomId = (await owner.post(ROOMS, { name: 'dev' }, { params: p })).status(201).json<{ room_id: string }>().room_id;
      const r = { ...p, roomId };

      await ctx.step('an agent granted project.room.write joins itself and posts → 200, 201', async () => {
        (await talker.client.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: talker.sessionId } })).status(200);
        (await talker.client.post(MESSAGES, { text: 'talker here' }, { params: r })).status(201);
      });
      await ctx.step('putting ANOTHER session in the room also needs project.session.start → the talker gets 403', async () => {
        (await talker.client.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: reader.sessionId } })).status(403);
      });
      await ctx.step('an agent granted only project.room.read reads the room but cannot post or join → 200, 403, 403', async () => {
        (await reader.client.get(MESSAGES, { params: r })).status(200).body().has('$.messages[0].text', 'talker here');
        (await reader.client.post(MESSAGES, { text: 'x' }, { params: r })).status(403);
        (await reader.client.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: reader.sessionId } })).status(403);
      });
      await ctx.step('an agent with no room permission cannot list or read rooms, or message a person → 403', async () => {
        (await mute.client.get(ROOMS, { params: p })).status(403);
        (await mute.client.get(MESSAGES, { params: r })).status(403);
        (await mute.client.post(DIRECT, { email: ctx.P.OWNER.email }, { params: p })).status(403);
      });
      await ctx.step('the owner may still put the mute agent in: a post is queued for it, and its answer through its session route → 403', async () => {
        (await owner.put(SESSION_MEMBER, {}, { params: { ...r, sessionId: mute.sessionId } })).status(200);
        const res = await owner.post(MESSAGES, { text: 'ping' }, { params: r });
        res.status(201);
        if (delivery(res.json<PostResult>(), mute.sessionId).state !== 'queued') throw new Error('mute not queued');
        (await mute.client.post(AS_SESSION_MESSAGES, { text: 'pong' }, { params: { ...p, sessionId: mute.sessionId, roomId } })).status(403);
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'ROOM-7',
  {
    domain: 'rooms',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/rooms/direct',
      'GET /v1/projects/:projectId/rooms/people',
      'POST /v1/projects/:projectId/rooms/:roomId/read',
      'PUT /v1/projects/:projectId/rooms/:roomId/members/people/:userId',
      'DELETE /v1/projects/:projectId/rooms/:roomId/members/people/:userId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const ada = await team.addMember('member');
    const bob = await team.addMember('member');
    const outsider = await team.addMember('member');
    for (const who of [ada, bob]) await team.grantProjectRole(project.id, who.userId!, 'member');
    await setDatabaseProjectFeature(ctx.env, project.id, 'agent_rooms', true);
    await setDatabaseProjectFeature(ctx.env, project.id, 'notification_center', true);
    const owner = ctx.client.as(ctx.P.OWNER);
    const asAda = ctx.client.as(ada);
    const asBob = ctx.client.as(bob);
    const p = { projectId: project.id };
    const builder = await createDatabaseSession(ctx.env, {
      projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'project', metadata: { name: 'Builder' },
    });
    ctx.track('session', builder, { projectId: project.id });

    await ctx.step('people lists the members with project access, not an account member without it', async () => {
      const res = await owner.get(PEOPLE, { params: p });
      res.status(200);
      const ids = res.json<{ people: { user_id: string }[] }>().people.map((x) => x.user_id);
      if (!ids.includes(ada.userId!) || !ids.includes(bob.userId!) || ids.includes(outsider.userId!)) throw new Error(JSON.stringify(ids));
    });

    let directId = '';
    await ctx.step('owner opens a direct conversation with Ada by email → 201 kind direct; again → 200, same id; an outsider → 404', async () => {
      const res = await owner.post(DIRECT, { email: ada.email }, { params: p });
      res.status(201).body().has('$.kind', 'direct').has('$.name', null).has('$.peer.kind', 'person');
      directId = res.json<{ room_id: string }>().room_id;
      (await owner.post(DIRECT, { user_id: ada.userId }, { params: p })).status(200).body().has('$.room_id', directId);
      (await owner.post(DIRECT, { user_id: outsider.userId }, { params: p })).status(404);
      (await owner.post(DIRECT, {}, { params: p })).status(400);
    });
    const d = { ...p, roomId: directId };

    await ctx.step('owner posts → Ada notified; Ada has 1 unread and a `message` notification that opens the conversation', async () => {
      const res = await owner.post(MESSAGES, { text: 'Can I drop the legacy_events table?' }, { params: d });
      res.status(201);
      if (delivery(res.json<PostResult>(), ada.userId!).state !== 'notified') throw new Error(`Ada not notified: ${res.text()}`);
      (await asAda.get(`${ROOMS}?mine=true`, { params: p })).status(200).body().has('$.rooms[0].room_id', directId).has('$.rooms[0].unread', 1);
      type Note = { kind: string; room_id: string; url: string; read: boolean };
      const note = await waitFor(async () => {
        const r = await asAda.get('/v1/notifications', { query: { limit: 20 } });
        return r.json<{ notifications: Note[] }>().notifications.find((n) => n.kind === 'message') ?? null;
      }, { until: (row) => row !== null, timeoutMs: 10_000, intervalMs: 250, description: 'message notification' });
      if (!note || note.room_id !== directId || !note.url.startsWith(`/projects/${project.id}/rooms/${directId}?notification=`) || note.read) throw new Error(JSON.stringify(note));
    });
    await ctx.step('a direct conversation is private: Bob reads, posts, gets → 404; no one can add a member → 409', async () => {
      (await asBob.get(MESSAGES, { params: d })).status(404);
      (await asBob.post(MESSAGES, { text: 'hi' }, { params: d })).status(404);
      (await asBob.get(ROOM, { params: d })).status(404);
      (await owner.put(PERSON_MEMBER, {}, { params: { ...d, userId: bob.userId! } })).status(409);
      (await owner.put(SESSION_MEMBER, {}, { params: { ...d, sessionId: builder } })).status(409);
    });
    await ctx.step('Ada marks it read → unread 0 and the notification is read; she answers → the owner has 1 unread', async () => {
      (await asAda.post(READ, {}, { params: d })).status(200).body().has('$.last_read_seq', 1);
      (await asAda.get(`${ROOMS}?mine=true`, { params: p })).status(200).body().has('$.rooms[0].unread', 0);
      const notes = (await asAda.get('/v1/notifications', { query: { limit: 20 } })).json<{ notifications: { kind: string; read: boolean }[] }>().notifications;
      if (notes.some((n) => n.kind === 'message' && !n.read)) throw new Error('message notification still unread');
      (await asAda.post(MESSAGES, { text: 'Yes, nothing reads it since July.', reply_to: 1 }, { params: d })).status(201);
      (await owner.get(`${ROOMS}?mine=true`, { params: p })).status(200).body().has('$.rooms[0].unread', 1);
    });
    await ctx.step('owner direct-messages the Builder session → a room event for it; the session cannot be given a second direct peer by Bob', async () => {
      const res = await owner.post(DIRECT, { session_id: builder }, { params: p });
      res.status(201).body().has('$.peer.kind', 'session');
      const sessionDirect = res.json<{ room_id: string }>().room_id;
      (await owner.post(MESSAGES, { text: 'What did migration 0049 change?' }, { params: { ...p, roomId: sessionDirect } })).status(201);
      const events = await roomEvents(ctx, builder);
      if (!events.some((t) => t.startsWith('[direct message · #1 · from ') && t.includes(`kortix rooms send ${sessionDirect}`))) throw new Error(JSON.stringify(events));
      (await asBob.get(MESSAGES, { params: { ...p, roomId: sessionDirect } })).status(404);
    });
    await ctx.step('a person joins a room themselves, gets unread from others, and leaves; adding an outsider → 404', async () => {
      const roomId = (await owner.post(ROOMS, { name: 'dev' }, { params: p })).status(201).json<{ room_id: string }>().room_id;
      const r = { ...p, roomId };
      (await asBob.put(PERSON_MEMBER, {}, { params: { ...r, userId: bob.userId! } })).status(200).body().has('$.kind', 'person');
      (await owner.put(PERSON_MEMBER, {}, { params: { ...r, userId: outsider.userId! } })).status(404);
      (await owner.post(MESSAGES, { text: 'deploy at 5' }, { params: r })).status(201);
      const mine = (await asBob.get(`${ROOMS}?mine=true`, { params: p })).json<{ rooms: Conversation[] }>().rooms;
      if (mine.find((x) => x.room_id === roomId)?.unread !== 1) throw new Error(JSON.stringify(mine));
      (await asBob.del(PERSON_MEMBER, { params: { ...r, userId: bob.userId! } })).status(200).body().has('$.removed', true);
      (await ctx.client.as(ada).del(PERSON_MEMBER, { params: { ...r, userId: bob.userId! } })).status(200).body().has('$.removed', false);
    });
  },
);
