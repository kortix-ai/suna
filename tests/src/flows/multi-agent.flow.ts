/**
 * MSG-1..3, TEAM-1 — cross-session messages, reachable agents and the agent
 * team task list (`@kortix/api-contract/multi-agent`).
 * Contract: tests/spec/end-to-end.md §37. The coalescing of notices, the hold
 * expiry and the idle notice are pinned in the DB suite
 * apps/api/src/__tests__/integration-multi-agent.test.ts; the delivered text
 * in packages/shared/src/peer-message-prompt.ts.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { withDb } from '../fixtures/chat';
import { bindDatabaseSessionCredential, createDatabaseSession, setDatabaseProjectFeature } from '../fixtures/database-project';

const REACHABLE = '/v1/projects/:projectId/sessions/:sessionId/reachable';
const SEND = '/v1/projects/:projectId/sessions/:sessionId/peer-messages';
const APPROVE = '/v1/projects/:projectId/sessions/:sessionId/peer-messages/:messageId/approve';
const DENY = '/v1/projects/:projectId/sessions/:sessionId/peer-messages/:messageId/deny';
const INBOUND = '/v1/projects/:projectId/sessions/:sessionId/inbound';
const TASKS = '/v1/projects/:projectId/sessions/:sessionId/tasks';
const TASK = '/v1/projects/:projectId/sessions/:sessionId/tasks/:seq';
const SESSION = '/v1/projects/:projectId/sessions/:sessionId';
const SESSIONS = '/v1/projects/:projectId/sessions';

type SendResult = { status: string; note: string; message: { id: string; status: string } | null; to: { handle: string; relation: string; can_receive: boolean } | null };

/** The peer-message delivery rows owed to a session: durable, queued even with no box. */
async function peerRows(ctx: FlowContext, sessionId: string) {
  return withDb(ctx, async (db) => (await db.query<{ text: string; status: string; delivery: string | null; author: string | null }>(
    `SELECT payload->>'text' AS text, status, payload->>'delivery' AS delivery, payload->>'authorSessionId' AS author
       FROM kortix.session_lifecycle_commands
      WHERE session_id = $1 AND source = 'system:peer-message' ORDER BY created_at`,
    [sessionId],
  )).rows);
}

/** A project PAT bound to `sessionId`: the credential a session's agent calls the API with. */
async function sessionToken(ctx: FlowContext, projectId: string, accountId: string, sessionId: string) {
  const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/projects/:projectId/cli-token', { name: ctx.fixtures.name('peer') }, { params: { projectId } });
  minted.status(201);
  const token = minted.json<{ token_id: string; secret_key: string }>();
  await bindDatabaseSessionCredential(ctx.env, { tokenId: token.token_id, commandId: crypto.randomUUID(), sessionId, accountId, projectId });
  return token;
}

async function dropTokens(ctx: FlowContext, projectId: string, tokenIds: string[]) {
  for (const tokenId of tokenIds) {
    await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', { params: { projectId, tokenId } }).catch(() => {});
  }
}

async function seeder(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  const project = await team.project();
  const seed = async (metadata: Record<string, unknown>, opts: { parent?: string; userId?: string; visibility?: 'private' | 'project' } = {}) => {
    const id = await createDatabaseSession(ctx.env, {
      projectId: project.id, accountId: team.id, userId: opts.userId ?? ctx.P.OWNER.userId!,
      visibility: opts.visibility ?? 'project', metadata, parentSessionId: opts.parent,
    });
    ctx.track('session', id, { projectId: project.id });
    return id;
  };
  return { team, project, seed };
}

flow(
  'MSG-1',
  {
    domain: 'multi-agent',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/reachable',
      'POST /v1/projects/:projectId/sessions/:sessionId/peer-messages',
      'GET /v1/projects/:projectId/sessions/:sessionId/peer-messages',
      'GET /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const { team, project, seed } = await seeder(ctx);
    const lead = await seed({ name: 'Lead', agent_handle: 'lead' });
    const reviewer = await seed({ name: 'Reviewer', agent_handle: 'reviewer', spawned_by_session: lead }, { parent: lead });
    const p = { projectId: project.id };
    const leadToken = await sessionToken(ctx, project.id, team.id, lead);
    const reviewerToken = await sessionToken(ctx, project.id, team.id, reviewer);
    const asLead = ctx.client.withBearer(leadToken.secret_key, 'lead session credential');
    const asReviewer = ctx.client.withBearer(reviewerToken.secret_key, 'reviewer session credential');
    try {
      await ctx.step('the lead lists who it can reach: itself, and the reviewer as its child that can receive', async () => {
        const res = await asLead.get(REACHABLE, { params: { ...p, sessionId: lead } });
        res.status(200).body().has('$.self.handle', 'lead').has('$.self.relation', 'self').has('$.agents.length', 1)
          .has('$.agents[0].handle', 'reviewer').has('$.agents[0].relation', 'child').has('$.agents[0].can_receive', true)
          .has('$.agents[0].inbound', 'accept').has('$.agents[0].short_id', reviewer.slice(0, 8));
        (await asLead.get(`${REACHABLE}?scope=project`, { params: { ...p, sessionId: lead } })).status(200).body().has('$.agents.length', 1);
      });
      let messageId = '';
      await ctx.step('the lead sends the reviewer a message by handle → 200 delivered at once; a durable steer row waits for the reviewer, who has no box', async () => {
        const started = Date.now();
        const res = await asLead.post(SEND, { to: '@reviewer', message: 'Review PR 12, focus on the parser.', summary: 'review PR 12' }, { params: { ...p, sessionId: lead } });
        res.status(200).body().has('$.status', 'delivered').has('$.to.handle', 'reviewer').has('$.message.from_handle', 'lead');
        if (Date.now() - started > 1_000) throw new Error(`send took ${Date.now() - started} ms; it must not wait for the receiver`);
        messageId = res.json<SendResult>().message!.id;
        const rows = await peerRows(ctx, reviewer);
        // Queued, or already claimed by the drain the send kicked; never failed for want of a box.
        if (rows.length !== 1 || !['queued', 'running'].includes(rows[0]!.status) || rows[0]!.delivery !== 'steer' || rows[0]!.author !== lead) throw new Error(JSON.stringify(rows));
        if (!rows[0]!.text.startsWith(`[message from lead · session ${lead.slice(0, 8)} · #${messageId} · review PR 12]\n\nReview PR 12, focus on the parser.\n`)) {
          throw new Error(`delivered text: ${rows[0]!.text.slice(0, 200)}`);
        }
      });
      await ctx.step('the reviewer reads it in its inbox and answers its parent by `parent` → delivered to the lead', async () => {
        (await asReviewer.get(`${SEND}?direction=in`, { params: { ...p, sessionId: reviewer } })).status(200).body()
          .has('$.messages.length', 1).has('$.messages[0].id', messageId).has('$.messages[0].status', 'delivered');
        (await asReviewer.post(SEND, { to: 'parent', message: 'Two issues in the parser.' }, { params: { ...p, sessionId: reviewer } }))
          .status(200).body().has('$.status', 'delivered').has('$.to.session_id', lead).has('$.to.relation', 'parent');
        if ((await peerRows(ctx, lead)).length !== 1) throw new Error('no delivery row for the lead');
        (await asLead.get(`${SEND}?direction=out`, { params: { ...p, sessionId: lead } })).status(200).body().has('$.messages.length', 1);
      });
      await ctx.step('the same text again within a minute → dropped, no second row; a short id prefix and the session id resolve too', async () => {
        (await asLead.post(SEND, { to: 'reviewer', message: 'Review PR 12, focus on the parser.' }, { params: { ...p, sessionId: lead } }))
          .status(200).body().has('$.status', 'dropped').has('$.message', null);
        (await asLead.post(SEND, { to: reviewer.slice(0, 8), message: 'Also check the tests.' }, { params: { ...p, sessionId: lead } })).status(200).body().has('$.status', 'delivered');
        (await asLead.post(SEND, { to: reviewer, message: 'And the docs.' }, { params: { ...p, sessionId: lead } })).status(200).body().has('$.status', 'delivered');
        if ((await peerRows(ctx, reviewer)).length !== 3) throw new Error('want 3 delivery rows');
      });
      await ctx.step('an unknown recipient → 404 recipient_not_found; itself → 400; an unknown field → 400', async () => {
        (await asLead.post(SEND, { to: 'nobody', message: 'hi' }, { params: { ...p, sessionId: lead } })).status(404).body().has('$.code', 'recipient_not_found');
        (await asLead.post(SEND, { to: lead, message: 'hi' }, { params: { ...p, sessionId: lead } })).status(400).body().has('$.code', 'recipient_is_self');
        (await asLead.post(SEND, { to: 'reviewer', message: 'hi', bogus: 1 }, { params: { ...p, sessionId: lead } })).status(400);
      });
      await ctx.step("the reviewer's token cannot speak for the lead → 403; NONMEMBER → 403; ANON → 401", async () => {
        (await asReviewer.post(SEND, { to: 'reviewer', message: 'as lead' }, { params: { ...p, sessionId: lead } })).status(403).body().has('$.code', 'not_this_session');
        (await ctx.client.as(ctx.P.NONMEMBER).get(REACHABLE, { params: { ...p, sessionId: lead } })).status(403);
        (await ctx.client.as(ctx.P.ANON).get(REACHABLE, { params: { ...p, sessionId: lead } })).status(401);
      });
      await ctx.step('the session row carries the board fields: agent_handle, inbound accept, board_state idle, attention null', async () => {
        (await ctx.client.as(ctx.P.OWNER).get(SESSION, { params: { ...p, sessionId: reviewer } })).status(200).body()
          .has('$.agent_handle', 'reviewer').has('$.inbound', 'accept').has('$.attention', null).has('$.team_lead_session_id', null).has('$.result_excerpt', null);
      });
    } finally {
      await dropTokens(ctx, project.id, [leadToken.token_id, reviewerToken.token_id]);
    }
  },
);

flow(
  'MSG-2',
  {
    domain: 'multi-agent',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/peer-messages',
      'GET /v1/projects/:projectId/sessions/:sessionId/peer-messages',
      'PUT /v1/projects/:projectId/sessions/:sessionId/inbound',
      'POST /v1/projects/:projectId/sessions/:sessionId/peer-messages/:messageId/approve',
      'POST /v1/projects/:projectId/sessions/:sessionId/peer-messages/:messageId/deny',
    ],
  },
  async (ctx) => {
    const { team, project, seed } = await seeder(ctx);
    const sender = await seed({ name: 'Sender', agent_handle: 'sender' });
    const target = await seed({ name: 'Target', agent_handle: 'target' });
    const twinA = await seed({ name: 'Writer A', agent_handle: 'writer' });
    const twinB = await seed({ name: 'Writer B', agent_handle: 'writer' });
    const p = { projectId: project.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    const token = await sessionToken(ctx, project.id, team.id, sender);
    const targetToken = await sessionToken(ctx, project.id, team.id, target);
    const asSender = ctx.client.withBearer(token.secret_key, 'sender session credential');
    const asTarget = ctx.client.withBearer(targetToken.secret_key, 'target session credential');
    const send = (body: Record<string, unknown>) => asSender.post(SEND, body, { params: { ...p, sessionId: sender } });
    try {
      await ctx.step('a handle two sessions share → 409 ambiguous_recipient naming both', async () => {
        const res = await send({ to: 'writer', message: 'which one?' });
        res.status(409).body().has('$.code', 'ambiguous_recipient').has('$.candidates.length', 2);
        const ids = res.json<{ candidates: { session_id: string }[] }>().candidates.map((c) => c.session_id).sort();
        if (ids.join() !== [twinA, twinB].sort().join()) throw new Error(JSON.stringify(ids));
      });
      await ctx.step("only the target's person sets inbound: the owner → 200; the target's own token → 403 person_only; a bad value → 400", async () => {
        (await owner.put(INBOUND, { inbound: 'refuse' }, { params: { ...p, sessionId: target } })).status(200).body().has('$.inbound', 'refuse');
        (await asTarget.put(INBOUND, { inbound: 'accept' }, { params: { ...p, sessionId: target } })).status(403).body().has('$.code', 'person_only');
        (await owner.put(INBOUND, { inbound: 'maybe' }, { params: { ...p, sessionId: target } })).status(400);
      });
      await ctx.step('refuse → 200 refused "Not sent: target refuses messages." and no delivery row', async () => {
        (await send({ to: 'target', message: 'hello?' })).status(200).body().has('$.status', 'refused').has('$.note', 'Not sent: target refuses messages.');
        if ((await peerRows(ctx, target)).length !== 0) throw new Error('a refused message was delivered');
      });
      let first = '';
      let second = '';
      await ctx.step('hold → held, no delivery row; the target lists both held messages above the refused one', async () => {
        (await owner.put(INBOUND, { inbound: 'hold' }, { params: { ...p, sessionId: target } })).status(200);
        const a = (await send({ to: 'target', message: 'may I start the deploy?' })).status(200);
        a.body().has('$.status', 'held');
        first = a.json<SendResult>().message!.id;
        const b = (await send({ to: 'target', message: 'second question' })).status(200);
        b.body().has('$.status', 'held');
        second = b.json<SendResult>().message!.id;
        if ((await peerRows(ctx, target)).length !== 0) throw new Error('a held message was delivered');
        (await owner.get(`${SEND}?direction=in`, { params: { ...p, sessionId: target } })).status(200).body().has('$.messages.length', 3)
          .has('$.messages[0].status', 'held').has('$.messages[1].status', 'held').has('$.messages[2].status', 'refused');
      });
      await ctx.step('the person approves the first → delivered and one delivery row; denies the second → denied; a second decision → 409', async () => {
        (await asTarget.post(APPROVE, {}, { params: { ...p, sessionId: target, messageId: first } })).status(403);
        (await owner.post(APPROVE, {}, { params: { ...p, sessionId: target, messageId: first } })).status(200).body().has('$.status', 'delivered');
        (await owner.post(DENY, {}, { params: { ...p, sessionId: target, messageId: second } })).status(200).body().has('$.status', 'denied');
        (await owner.post(APPROVE, {}, { params: { ...p, sessionId: target, messageId: second } })).status(409).body().has('$.code', 'peer_message_not_held');
        (await owner.post(APPROVE, {}, { params: { ...p, sessionId: target, messageId: 'm_unknown' } })).status(404);
        const rows = await peerRows(ctx, target);
        if (rows.length !== 1 || !rows[0]!.text.includes('may I start the deploy?')) throw new Error(JSON.stringify(rows));
        (await asSender.get(`${SEND}?direction=out`, { params: { ...p, sessionId: sender } })).status(200).body().has('$.messages[0].status', 'denied');
      });
    } finally {
      await dropTokens(ctx, project.id, [token.token_id, targetToken.token_id]);
    }
  },
);

flow(
  'MSG-3',
  {
    domain: 'multi-agent',
    requires: ['database'],
    routes: ['POST /v1/projects/:projectId/sessions/:sessionId/peer-messages'],
  },
  async (ctx) => {
    const { team, project, seed } = await seeder(ctx);
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const chatty = await seed({ name: 'Chatty', agent_handle: 'chatty' });
    const target = await seed({ name: 'Target', agent_handle: 'target' });
    const secret = await seed({ name: 'Private', agent_handle: 'secret' }, { visibility: 'private' });
    const mine = await seed({ name: 'Mine', agent_handle: 'mine' }, { userId: member.userId! });
    const p = { projectId: project.id };
    const token = await sessionToken(ctx, project.id, team.id, chatty);
    const asChatty = ctx.client.withBearer(token.secret_key, 'chatty session credential');
    try {
      await ctx.step(`${30} messages in a minute are delivered; the 31st → 429 peer_rate_limited`, async () => {
        for (let i = 1; i <= 30; i += 1) {
          (await asChatty.post(SEND, { to: 'target', message: `update ${i}` }, { params: { ...p, sessionId: chatty } })).status(200).body().has('$.status', 'delivered');
        }
        (await asChatty.post(SEND, { to: 'target', message: 'update 31' }, { params: { ...p, sessionId: chatty } })).status(429).body().has('$.code', 'peer_rate_limited');
        if ((await peerRows(ctx, target)).length !== 30) throw new Error('want 30 delivery rows');
      });
      await ctx.step("a member sending from their own session: the owner's private session does not exist for them (404, by id or handle), a project session they may prompt receives it", async () => {
        const asMember = ctx.client.as(member);
        (await asMember.post(SEND, { to: secret, message: 'let me in' }, { params: { ...p, sessionId: mine } })).status(404).body().has('$.code', 'recipient_not_found');
        (await asMember.post(SEND, { to: 'secret', message: 'let me in' }, { params: { ...p, sessionId: mine } })).status(404);
        if ((await peerRows(ctx, secret)).length !== 0) throw new Error('the private session got the message');
        (await asMember.post(SEND, { to: 'target', message: 'from the member' }, { params: { ...p, sessionId: mine } })).status(200).body().has('$.status', 'delivered');
      });
      await ctx.step("a member cannot send as the owner's private session → 404", async () => {
        (await ctx.client.as(member).post(SEND, { to: 'target', message: 'as secret' }, { params: { ...p, sessionId: secret } })).status(404);
      });
    } finally {
      await dropTokens(ctx, project.id, [token.token_id]);
    }
  },
);

flow(
  'TEAM-1',
  {
    domain: 'multi-agent',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/tasks',
      'POST /v1/projects/:projectId/sessions/:sessionId/tasks',
      'GET /v1/projects/:projectId/sessions/:sessionId/tasks/:seq',
      'PATCH /v1/projects/:projectId/sessions/:sessionId/tasks/:seq',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/tasks/:seq',
      'GET /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions',
      'PATCH /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const { team, project, seed } = await seeder(ctx);
    const lead = await seed({ name: 'Lead', agent_handle: 'lead' });
    const mate = (handle: string) => seed({ name: handle, agent_handle: handle, team_lead: lead, spawned_by_session: lead }, { parent: lead });
    const x = await mate('builder');
    const y = await mate('tester');
    const outsider = await seed({ name: 'Outsider', agent_handle: 'outsider' });
    const p = { projectId: project.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    const tokens = await Promise.all([lead, x, y, outsider].map((id) => sessionToken(ctx, project.id, team.id, id)));
    const [asLead, asX, asY, asOutsider] = tokens.map((t, i) => ctx.client.withBearer(t.secret_key, `session ${i} credential`));
    const l = { ...p, sessionId: lead };
    try {
      await ctx.step('flag agent_teams off (the default): list and create → 403 feature_disabled; messages still work', async () => {
        (await asLead!.get(TASKS, { params: l })).status(403).body().has('$.code', 'feature_disabled');
        (await asLead!.post(TASKS, { subject: 'x' }, { params: l })).status(403).body().has('$.code', 'feature_disabled');
        (await asLead!.post(SEND, { to: 'builder', message: 'hello team' }, { params: l })).status(200).body().has('$.status', 'delivered');
      });
      await setDatabaseProjectFeature(ctx.env, project.id, 'agent_teams', true);
      await ctx.step('the lead creates #1 and #2 (blocked by #1, owned by tester) → 201', async () => {
        (await asLead!.post(TASKS, { subject: 'Write the parser', description: 'src/parser.ts' }, { params: l })).status(201).body()
          .has('$.seq', 1).has('$.status', 'pending').has('$.blocked', false).has('$.created_by_session_id', lead);
        (await asLead!.post(TASKS, { subject: 'Test the parser', blocked_by: [1], owner: 'tester' }, { params: l })).status(201).body()
          .has('$.seq', 2).has('$.blocked', true).has('$.owner_handle', 'tester').has('$.owner_session_id', y);
        (await asLead!.post(TASKS, { subject: 'x', owner: 'nobody' }, { params: l })).status(400).body().has('$.code', 'unknown_teammate');
        (await asLead!.post(TASKS, { subject: 'x', blocked_by: [9] }, { params: l })).status(400).body().has('$.code', 'task_not_found');
      });
      await ctx.step('two teammates claim #1 at the same moment → exactly one 200, one 409 task_taken', async () => {
        const [a, b] = await Promise.all([
          asX!.patch(TASK, { claim: true }, { params: { ...l, seq: 1 } }),
          asY!.patch(TASK, { claim: true }, { params: { ...l, seq: 1 } }),
        ]);
        const codes = [a.statusCode, b.statusCode].sort();
        if (codes.join() !== '200,409') throw new Error(`claims answered ${codes.join()}: ${a.text()} / ${b.text()}`);
        const lost = a.statusCode === 409 ? a : b;
        lost.body().has('$.code', 'task_taken');
        (await asLead!.get(TASK, { params: { ...l, seq: 1 } })).status(200).body().has('$.status', 'in_progress');
      });
      await ctx.step('#2 is blocked: claiming it → 409 task_blocked; #1 completed → #2 unblocked and its owner claims it', async () => {
        (await asY!.patch(TASK, { claim: true }, { params: { ...l, seq: 2 } })).status(409).body().has('$.code', 'task_blocked');
        (await asX!.patch(TASK, { status: 'completed' }, { params: { ...l, seq: 1 } })).status(200).body().has('$.status', 'completed');
        (await asLead!.get(TASKS, { params: l })).status(200).body().has('$.tasks.length', 2).has('$.tasks[1].blocked', false);
        (await asY!.patch(TASK, { claim: true }, { params: { ...l, seq: 2 } })).status(200).body().has('$.status', 'in_progress').has('$.owner_handle', 'tester');
      });
      await ctx.step('a session outside the team → 403 not_in_team; the person reads the list; an unknown task → 404', async () => {
        (await asOutsider!.get(TASKS, { params: l })).status(403).body().has('$.code', 'not_in_team');
        (await owner.get(TASKS, { params: l })).status(200).body().has('$.tasks.length', 2);
        (await owner.get(TASK, { params: { ...l, seq: 99 } })).status(404);
        (await ctx.client.as(ctx.P.NONMEMBER).get(TASKS, { params: l })).status(403);
      });
      await ctx.step('?team_lead=<lead> lists the two teammates with team_lead_session_id and agent_handle', async () => {
        const res = await owner.get(`${SESSIONS}?team_lead=${lead}`, { params: p });
        res.status(200);
        const rows = res.json<Array<{ session_id: string; team_lead_session_id: string | null; agent_handle: string | null; board_state: string }>>();
        if (rows.map((r) => r.session_id).sort().join() !== [x, y].sort().join()) throw new Error(JSON.stringify(rows.map((r) => r.session_id)));
        if (rows.some((r) => r.team_lead_session_id !== lead || !r.agent_handle || !r.board_state)) throw new Error(JSON.stringify(rows));
      });
      await ctx.step("no session joins another's team: team_lead naming another session → 400 team_lead_must_be_caller; a taken handle → 409; PATCH team_lead → 400", async () => {
        (await asOutsider!.post(SESSIONS, { metadata: { team_lead: lead } }, { params: p })).status(400).body().has('$.code', 'team_lead_must_be_caller');
        (await asOutsider!.post(SESSIONS, { runtime_context: { 'kortix.team.lead': lead } }, { params: p })).status(400).body().has('$.code', 'team_lead_must_be_caller');
        (await owner.post(SESSIONS, { metadata: { team_lead: lead } }, { params: p })).status(400).body().has('$.code', 'team_lead_must_be_caller');
        (await asLead!.post(SESSIONS, { metadata: { team_lead: lead, agent_handle: 'builder' } }, { params: p })).status(409).body().has('$.code', 'agent_handle_taken');
        (await asLead!.post(SESSIONS, { metadata: { agent_handle: 'has space' } }, { params: p })).status(400).body().has('$.code', 'invalid_agent_handle');
        (await owner.patch(SESSION, { metadata: { team_lead: lead } }, { params: { ...p, sessionId: outsider } })).status(400);
      });
      await ctx.step('the lead deletes #1 → {deleted:true}; #2 no longer waits for it', async () => {
        (await asLead!.del(TASK, { params: { ...l, seq: 1 } })).status(200).body().has('$.deleted', true);
        (await asLead!.get(TASK, { params: { ...l, seq: 2 } })).status(200).body().has('$.blocked_by.length', 0);
      });
    } finally {
      await dropTokens(ctx, project.id, tokens.map((t) => t.token_id));
    }
  },
);
