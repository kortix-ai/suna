/**
 * ROOM-1..3 — Rooms: sessions and people message each other.
 * Contract: tests/spec/end-to-end.md §35. Pure rules (mentions, the agent-chain
 * pause, the delivered text) are pinned in apps/api/src/projects/rooms/envelope.test.ts.
 */
import { flow } from '../core/flow';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { CliSandbox, type CliResult } from '../fixtures/cli';
import { bindDatabaseSessionCredential, createDatabaseSession, setDatabaseProjectFeature } from '../fixtures/database-project';
import type { FlowContext } from '../core/types';

const ROOMS = '/v1/projects/:projectId/rooms';
const ROOM = '/v1/projects/:projectId/rooms/:roomId';
const MESSAGES = '/v1/projects/:projectId/rooms/:roomId/messages';
const MEMBER = '/v1/projects/:projectId/rooms/:roomId/members/:sessionId';
const SESSION_ROOMS = '/v1/projects/:projectId/sessions/:sessionId/rooms';
const PROMPTS = '/v1/projects/:projectId/sessions/:sessionId/prompts';
const AS_SESSION = '/v1/projects/:projectId/sessions/:sessionId/rooms/:roomId';
const AS_SESSION_MESSAGES = '/v1/projects/:projectId/sessions/:sessionId/rooms/:roomId/messages';

type Delivery = { session_id: string; state: string; reason?: string };
type PostResult = { message: { seq: number; sender_kind: string; sender_session_id: string | null }; deliveries: Delivery[]; paused: boolean };

function delivery(result: PostResult, sessionId: string): Delivery {
  const found = result.deliveries.find((d) => d.session_id === sessionId);
  if (!found) throw new Error(`no delivery verdict for ${sessionId}: ${JSON.stringify(result.deliveries)}`);
  return found;
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
    await ctx.step('owner creates platinum/dev → 201; the same name again → 200 with the same room_id', async () => {
      const created = await owner.post(ROOMS, { name: 'platinum/dev', topic: 'who is touching dev' }, { params: p });
      created.status(201).body().has('$.name', 'platinum/dev').has('$.topic', 'who is touching dev').has('$.last_seq', 0);
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
      'PUT /v1/projects/:projectId/rooms/:roomId/members/:sessionId',
      'DELETE /v1/projects/:projectId/rooms/:roomId/members/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
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

    await ctx.step('owner joins Builder (notify all) and Reviewer (notify mentions) → 200', async () => {
      (await owner.put(MEMBER, {}, { params: { ...r, sessionId: builder } })).status(200).body().has('$.notify', 'all').has('$.session_name', 'Builder');
      (await owner.put(MEMBER, { notify: 'mentions' }, { params: { ...r, sessionId: reviewer } })).status(200).body().has('$.notify', 'mentions');
    });
    await ctx.step("a member cannot put the owner's private session in the room → 404; an unknown session → 404", async () => {
      (await ctx.client.as(member).put(MEMBER, {}, { params: { ...r, sessionId: secret } })).status(404);
      (await owner.put(MEMBER, {}, { params: { ...r, sessionId: crypto.randomUUID() } })).status(404);
    });
    await ctx.step('GET the room lists both members', async () => {
      (await owner.get(ROOM, { params: r })).status(200).body().has('$.members.length', 2).has('$.member_count', 2);
    });

    await ctx.step('owner posts → 201 #1; Builder gets it in its inbox, Reviewer is skipped (not_mentioned)', async () => {
      const res = await owner.post(MESSAGES, { text: 'who blocked dev?' }, { params: r });
      res.status(201).body().has('$.message.seq', 1).has('$.message.sender_kind', 'member').has('$.paused', false);
      const result = res.json<PostResult>();
      if (delivery(result, builder).state !== 'queued') throw new Error('Builder not queued');
      if (delivery(result, reviewer).reason !== 'not_mentioned') throw new Error('Reviewer not skipped as not_mentioned');
      const prompts = await owner.get(PROMPTS, { params: { ...p, sessionId: builder } });
      prompts.status(200);
      const rows = prompts.json<{ prompts: { full_text?: string; text: string; delivery?: string }[] }>().prompts;
      const row = rows.find((x) => (x.full_text ?? x.text).includes('[room dev · #1 · from '));
      if (!row) throw new Error(`no room prompt in Builder's inbox: ${JSON.stringify(rows)}`);
      if (!(row.full_text ?? row.text).includes('kortix rooms send dev --reply-to 1')) throw new Error('no reply command in the delivered text');
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
    await ctx.step('leave Reviewer → removed:true; again → removed:false', async () => {
      (await owner.del(MEMBER, { params: { ...r, sessionId: reviewer } })).status(200).body().has('$.removed', true);
      (await owner.del(MEMBER, { params: { ...r, sessionId: reviewer } })).status(200).body().has('$.removed', false);
    });
    await ctx.step('an archived room takes no message → 409 and no join → 409', async () => {
      (await owner.patch(ROOM, { archived: true }, { params: r })).status(200);
      (await owner.post(MESSAGES, { text: 'late' }, { params: r })).status(409);
      (await owner.put(MEMBER, {}, { params: { ...r, sessionId: reviewer } })).status(409);
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
    for (const sessionId of [alpha, beta]) (await owner.put(MEMBER, {}, { params: { ...r, sessionId } })).status(200);

    const minted = await owner.post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('room3') }, { params: p });
    minted.status(201);
    const token = minted.json<{ token_id: string; secret_key: string }>();
    await bindDatabaseSessionCredential(ctx.env, {
      tokenId: token.token_id, commandId: crypto.randomUUID(), sessionId: alpha, accountId: team.id, projectId: project.id,
    });
    const asAlpha = ctx.client.withBearer(token.secret_key, 'Alpha session credential');

    try {
      await ctx.step("Alpha's own token lists Alpha's rooms", async () => {
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
      await ctx.step('Alpha leaves the room itself → removed:true', async () => {
        (await asAlpha.del(MEMBER, { params: { ...r, sessionId: alpha } })).status(200).body().has('$.removed', true);
      });
    } finally {
      await owner.del('/v1/projects/:projectId/cli-token/:tokenId', { params: { ...p, tokenId: token.token_id } }).catch(() => {});
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
      (await owner.put(MEMBER, {}, { params: { ...r, sessionId: gamma } })).status(403).body().has('$.code', 'feature_disabled');
      await setDatabaseProjectFeature(ctx.env, other.id, 'agent_rooms', true);
      (await owner.put(MEMBER, {}, { params: { ...r, sessionId: gamma } })).status(200).body().has('$.project_id', other.id);
    });

    const minted = await owner.post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('room4') }, { params: { projectId: other.id } });
    minted.status(201);
    const token = minted.json<{ token_id: string; secret_key: string }>();
    await bindDatabaseSessionCredential(ctx.env, {
      tokenId: token.token_id, commandId: crypto.randomUUID(), sessionId: gamma, accountId: team.id, projectId: other.id,
    });
    const asGamma = ctx.client.withBearer(token.secret_key, 'Gamma session credential');
    try {
      await ctx.step("Gamma's token, bound to its own project, cannot list the home project's rooms → 403", async () => {
        (await asGamma.get(ROOMS, { params: { projectId: home.id } })).status(403);
      });
      await ctx.step("Gamma finds the room through its own session's rooms, with the room's project_id", async () => {
        (await asGamma.get(SESSION_ROOMS, { params: { projectId: other.id, sessionId: gamma } }))
          .status(200).body().has('$.rooms[0].room_id', roomId).has('$.rooms[0].project_id', home.id);
      });
      const g = { projectId: other.id, sessionId: gamma, roomId };
      await ctx.step('the owner posts → Gamma queued; Gamma reads and answers as itself under its own project → 201 sender_kind session', async () => {
        const res = await owner.post(MESSAGES, { text: 'did you block dev?' }, { params: r });
        res.status(201);
        if (delivery(res.json<PostResult>(), gamma).state !== 'queued') throw new Error('Gamma not queued');
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
      await owner.del('/v1/projects/:projectId/cli-token/:tokenId', { params: { projectId: other.id, tokenId: token.token_id } }).catch(() => {});
    }
  },
);

/** A project PAT bound to `sessionId`: the credential a session's agent runs the CLI with. */
async function sessionToken(ctx: FlowContext, projectId: string, accountId: string, sessionId: string) {
  const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('room') }, { params: { projectId } });
  minted.status(201);
  const token = minted.json<{ token_id: string; secret_key: string }>();
  await bindDatabaseSessionCredential(ctx.env, { tokenId: token.token_id, commandId: crypto.randomUUID(), sessionId, accountId, projectId });
  return token;
}

function ok(result: CliResult, what: string, code = 0): CliResult {
  if (result.exitCode !== code) throw new Error(`${what}: exit ${result.exitCode} (want ${code}): ${result.all.slice(0, 800)}`);
  return result;
}

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
    const run = (env: Record<string, string>, args: string[], stdin?: string) => sandbox.run(['rooms', ...args], { env, stdin });
    try {
      await ctx.step('`rooms join dev --session <alpha> --topic … --json` creates the room and the membership → exit 0', async () => {
        const out = JSON.parse(ok(await run(person, ['join', 'dev', '--session', alpha, '--topic', 'dev deploys', '--json']), 'join').stdout);
        if (!out.created || out.room.name !== 'dev' || out.member.notify !== 'all') throw new Error(`unexpected join: ${JSON.stringify(out)}`);
      });
      await ctx.step('`rooms send dev "…" --json` as the person → seq 1, delivered to Alpha', async () => {
        const out = JSON.parse(ok(await run(person, ['send', 'dev', 'who blocked dev?', '--json']), 'send').stdout);
        if (out.message.seq !== 1 || !out.deliveries.some((d: any) => d.session_id === alpha && d.state === 'queued')) throw new Error(JSON.stringify(out));
      });
      await ctx.step('inside Alpha: `rooms read dev --json` sees #1; a reply piped on stdin with --reply-to 1 → exit 0', async () => {
        const read = JSON.parse(ok(await run(asAlpha, ['read', 'dev', '--json']), 'read').stdout);
        if (read.messages[0]?.text !== 'who blocked dev?') throw new Error(JSON.stringify(read));
        const sent = JSON.parse(ok(await run(asAlpha, ['send', 'dev', '--reply-to', '1', '--json'], 'I did, reverting'), 'reply').stdout);
        if (sent.message.sender_session_id !== alpha || sent.message.reply_to_seq !== 1) throw new Error(JSON.stringify(sent));
      });
      await ctx.step('the person: `rooms next dev --after 1 --json` prints Alpha\'s reply; nothing newer → exit 4', async () => {
        const next = JSON.parse(ok(await run(person, ['next', 'dev', '--after', '1', '--timeout', '5', '--json']), 'next').stdout);
        if (next.message?.text !== 'I did, reverting') throw new Error(JSON.stringify(next));
        ok(await run(person, ['next', 'dev', '--timeout', '2']), 'next timeout', 4);
      });
      await ctx.step('a session of another project, joined by the person, answers with plain `rooms send dev` → its session route', async () => {
        ok(await run({ ...person, KORTIX_PROJECT_ID: home.id }, ['join', 'dev', '--session', gamma, '--json']), 'join gamma');
        const sent = JSON.parse(ok(await run(asGamma, ['send', 'dev', 'not me, I was on staging', '--json']), 'gamma send').stdout);
        if (sent.message.sender_session_id !== gamma) throw new Error(JSON.stringify(sent));
        if (!sent.deliveries.some((d: any) => d.session_id === alpha && d.state === 'queued')) throw new Error('Alpha did not get Gamma\'s message');
        const left = JSON.parse(ok(await run(asGamma, ['leave', 'dev', '--json']), 'gamma leave').stdout);
        if (left.removed !== true) throw new Error(JSON.stringify(left));
      });
      await ctx.step('`rooms ls --json` lists dev with 1 member and 3 messages; `rooms info dev` names Alpha', async () => {
        const ls = JSON.parse(ok(await run(person, ['ls', '--json']), 'ls').stdout);
        const dev = ls.rooms.find((room: any) => room.name === 'dev');
        if (dev?.member_count !== 1 || dev?.last_seq !== 3) throw new Error(JSON.stringify(ls));
        const info = ok(await run(person, ['info', 'dev']), 'info').stdout;
        if (!info.includes('Alpha') || !info.includes(alpha.split('-')[0]!)) throw new Error(info);
      });
      await ctx.step('usage errors exit 2 without a request: unknown subcommand, bad --notify, send with no text', async () => {
        ok(await run(person, ['bogus']), 'bogus', 2);
        ok(await run(person, ['join', 'dev', '--notify', 'loud']), 'notify', 2);
        ok(await run(person, ['send', 'dev'], ''), 'empty send', 2);
      });
    } finally {
      sandbox.dispose();
      for (const [projectId, token] of [[home.id, alphaToken], [other.id, gammaToken]] as const) {
        await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', { params: { projectId, tokenId: token.token_id } }).catch(() => {});
      }
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
        (await talker.client.put(MEMBER, {}, { params: { ...r, sessionId: talker.sessionId } })).status(200);
        (await talker.client.post(MESSAGES, { text: 'talker here' }, { params: r })).status(201);
      });
      await ctx.step('putting ANOTHER session in the room also needs project.session.start → the talker gets 403', async () => {
        (await talker.client.put(MEMBER, {}, { params: { ...r, sessionId: reader.sessionId } })).status(403);
      });
      await ctx.step('an agent granted only project.room.read reads the room but cannot post or join → 200, 403, 403', async () => {
        (await reader.client.get(MESSAGES, { params: r })).status(200).body().has('$.messages[0].text', 'talker here');
        (await reader.client.post(MESSAGES, { text: 'x' }, { params: r })).status(403);
        (await reader.client.put(MEMBER, {}, { params: { ...r, sessionId: reader.sessionId } })).status(403);
      });
      await ctx.step('an agent with no room permission cannot list or read rooms → 403', async () => {
        (await mute.client.get(ROOMS, { params: p })).status(403);
        (await mute.client.get(MESSAGES, { params: r })).status(403);
      });
      await ctx.step('the owner may put the mute agent in the room; a delivery reaches it, but it cannot answer → 403', async () => {
        (await owner.put(MEMBER, {}, { params: { ...r, sessionId: mute.sessionId } })).status(200);
        const res = await owner.post(MESSAGES, { text: 'ping' }, { params: r });
        res.status(201);
        if (delivery(res.json<PostResult>(), mute.sessionId).state !== 'queued') throw new Error('mute not queued');
        (await mute.client.post(`${SESSION_ROOMS}/:roomId/messages`, { text: 'pong' }, { params: { ...p, sessionId: mute.sessionId, roomId } })).status(403);
      });
    } finally {
      await world.close();
    }
  },
);
