/**
 * Goals — the server lifecycle record (`/v1/projects/:projectId/goals/*`,
 * flag `goals`). Spec: tests/spec/end-to-end.md § 12d Goals. Source of truth:
 * apps/api/src/projects/routes/goals.ts + apps/api/src/projects/goals/.
 *
 * The local profile runs no scheduler, no sandbox and no Drive storage, so a
 * goal created here keeps `blocked_reason: setup` (its GOAL.md write fails),
 * and every lifecycle move still runs against the row. The heartbeat FIRE
 * path (admission gate, wake cap across UTC midnight, successor adoption,
 * event wakes) is proved in apps/api/src/__tests__/integration-goals.test.ts.
 * A goal worked end to end by a real model turn needs the `sandbox`
 * capability and is not part of these flows.
 */
import { randomUUID } from 'node:crypto';
import { mintAccountToken, type Client } from '../core/client';
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';

const R = {
  list: 'GET /v1/projects/:projectId/goals',
  create: 'POST /v1/projects/:projectId/goals',
  read: 'GET /v1/projects/:projectId/goals/:goalId',
  edit: 'PATCH /v1/projects/:projectId/goals/:goalId',
  events: 'GET /v1/projects/:projectId/goals/:goalId/events',
  criteria: 'PUT /v1/projects/:projectId/goals/:goalId/criteria',
  activate: 'POST /v1/projects/:projectId/goals/:goalId/activate',
  wait: 'POST /v1/projects/:projectId/goals/:goalId/wait',
  answer: 'POST /v1/projects/:projectId/goals/:goalId/answer',
  progress: 'POST /v1/projects/:projectId/goals/:goalId/progress',
  verify: 'POST /v1/projects/:projectId/goals/:goalId/request-verification',
  verdict: 'POST /v1/projects/:projectId/goals/:goalId/verdict',
  handover: 'POST /v1/projects/:projectId/goals/:goalId/handover',
  pause: 'POST /v1/projects/:projectId/goals/:goalId/pause',
  resume: 'POST /v1/projects/:projectId/goals/:goalId/resume',
  stop: 'POST /v1/projects/:projectId/goals/:goalId/stop',
  restart: 'POST /v1/projects/:projectId/goals/:goalId/restart',
} as const;
const path = (route: string) => route.slice(route.indexOf(' ') + 1);
const GOALS = path(R.list);
const GOAL = path(R.read);
const verb = (route: string) => path(route);
const MANIFEST = 'project:\n  name: ke2e-goals\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n';

interface Goal {
  goal_id: string;
  revision: number;
  state: string;
  title: string;
  folder: string;
  box_folder: string;
  owner_session_id: string | null;
  blocked_reason: string | null;
  paused_at: string | null;
  criteria: Array<{ id: string; reported_met: boolean; evidence: string | null; verified: boolean }>;
  criteria_revision: number;
  capabilities: Record<string, boolean>;
  provenance: string;
}

async function openWorld(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  await world.writeManifest(MANIFEST, 'ke2e: goals agent');
  await world.setFeature('reminders', true);
  await world.setFeature('goals', true);
  await world.fund();
  return { team, project, world, owner: ctx.client.as(ctx.P.OWNER) };
}

/**
 * The goal's owner session credential: a session token bound to the session
 * the API made for the goal. When the local stack could not create that
 * session, the fixture inserts its row, and a create retry finishes setup.
 */
async function ownerCredential(ctx: FlowContext, world: AgentPrincipalsWorld, sessionId: string): Promise<Client> {
  const { rows } = await world.db.query<{ n: number }>('SELECT count(*)::int AS n FROM kortix.project_sessions WHERE session_id = $1', [sessionId]);
  if (!rows[0]?.n) {
    const minted = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER, sessionId, skipGrantSync: true });
    return minted.client;
  }
  const credential = await mintAccountToken(ctx.client.as(ctx.P.OWNER), `goal owner ${sessionId.slice(0, 8)}`);
  world.tokens.push(credential.token_id);
  const serviceAccountId = await world.serviceAccountId('kortix');
  await world.db.query(
    `UPDATE kortix.account_tokens SET account_id = $2, user_id = $3, project_id = $4, session_id = $5, service_account_id = $6, agent_grant = NULL WHERE token_id = $1`,
    [credential.token_id, world.accountId, ctx.P.OWNER.userId, world.projectId, sessionId, serviceAccountId],
  );
  return ctx.client.withBearer(credential.secret_key, 'GOAL_OWNER');
}

async function createGoal(owner: Client, projectId: string, body: Record<string, unknown> = {}): Promise<Goal> {
  const r = await owner.post(GOALS, { goal_id: randomUUID(), brief: `Publish the synthetic report ${randomUUID().slice(0, 6)}\nFor the review.`, criteria: ['The report is in Files', 'The owner signed off'], agent: 'kortix', ...body }, { params: { projectId }, timeoutMs: 60_000 });
  r.status(201);
  return r.json<{ goal: Goal }>().goal;
}

const read = async (client: Client, projectId: string, goalId: string) =>
  (await client.get(GOAL, { params: { projectId, goalId } })).status(200).json<{ goal: Goal }>().goal;

function expectError(r: { statusCode: number; json<T>(): T; text(): string }, status: number, code: string) {
  if (r.statusCode !== status) throw new Error(`expected ${status} ${code}, got ${r.statusCode}: ${r.text()}`);
  const body = r.json<{ error?: string; code?: string }>();
  if (body.error !== code && body.code !== code) throw new Error(`expected ${code}, got ${r.text()}`);
}

flow(
  'GOAL-1',
  {
    domain: 'goals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [R.list, R.create, R.read, R.events, 'PATCH /v1/projects/:projectId/features'],
  },
  async (ctx) => {
    const { project, world, owner } = await openWorld(ctx);
    const params = { projectId: project.id };
    try {
      await ctx.step('an anonymous caller → 401 on the list', async () => {
        (await ctx.client.as(ctx.P.ANON).get(GOALS, { params })).status(401);
      });

      await ctx.step('the flag off → every goals route answers 403 feature_disabled; on again → 200', async () => {
        await world.setFeature('goals', false);
        expectError(await owner.get(GOALS, { params }), 403, 'feature_disabled');
        expectError(await owner.post(GOALS, { goal_id: randomUUID(), brief: 'x' }, { params }), 403, 'feature_disabled');
        await world.setFeature('goals', true);
        (await owner.get(GOALS, { params })).status(200);
      });

      await ctx.step('a body without brief, or with 9 criteria → 422 goal_invalid with violations, nothing stored', async () => {
        const r = await owner.post(GOALS, { goal_id: randomUUID() }, { params });
        expectError(r, 422, 'goal_invalid');
        if (!r.json<{ violations?: string[] }>().violations?.length) throw new Error('no violations');
        expectError(await owner.post(GOALS, { goal_id: randomUUID(), brief: 'x', criteria: Array.from({ length: 9 }, (_, i) => `c${i}`) }, { params }), 422, 'goal_invalid');
        const listed = (await owner.get(GOALS, { params })).json<{ goals: Goal[] }>().goals;
        if (listed.length !== 0) throw new Error(`expected no goal, got ${listed.length}`);
      });

      let goal: Goal | null = null;
      const goalId = randomUUID();
      await ctx.step('the owner creates a goal → 201 draft in their own folder, criteria revision 1, owner session named', async () => {
        goal = await createGoal(owner, project.id, { goal_id: goalId, brief: 'Ship the synthetic launch notes\nShort and plain.' });
        if (goal.goal_id !== goalId || goal.state !== 'draft' || goal.title !== 'Ship the synthetic launch notes') throw new Error(JSON.stringify(goal));
        if (!/^\/Users\/[^/]+\/Goals\/ship-the-synthetic-launch-notes$/.test(goal.folder)) throw new Error(`folder ${goal.folder}`);
        if (goal.box_folder !== '/drives/me/Goals/ship-the-synthetic-launch-notes') throw new Error(`box folder ${goal.box_folder}`);
        if (!goal.owner_session_id || goal.criteria_revision !== 1 || goal.criteria.length !== 2 || goal.provenance !== 'api') throw new Error(JSON.stringify(goal));
        if (!goal.capabilities.pause || !goal.capabilities.stop || goal.capabilities.restart) throw new Error(`capabilities ${JSON.stringify(goal.capabilities)}`);
      });

      await ctx.step('a retry with the same goal_id returns the same goal: one row, one folder', async () => {
        const again = await createGoal(owner, project.id, { goal_id: goalId, brief: 'Ship the synthetic launch notes\nShort and plain.' });
        if (again.goal_id !== goalId || again.folder !== goal!.folder) throw new Error(JSON.stringify(again));
        const listed = (await owner.get(GOALS, { params })).json<{ goals: Goal[] }>().goals;
        if (listed.filter((g) => g.goal_id === goalId).length !== 1) throw new Error('duplicate goal');
      });

      await ctx.step('a second goal with the same title gets its own folder (-2)', async () => {
        const second = await createGoal(owner, project.id, { brief: 'Ship the synthetic launch notes' });
        if (!second.folder.endsWith('/ship-the-synthetic-launch-notes-2')) throw new Error(second.folder);
      });

      await ctx.step('read back → 200 with capabilities; the events start with `created`', async () => {
        const back = await read(owner, project.id, goalId);
        if (back.goal_id !== goalId) throw new Error('wrong goal');
        const events = (await owner.get(path(R.events), { params: { ...params, goalId } })).status(200).json<{ events: Array<{ kind: string; actor_kind: string }> }>().events;
        const created = events.find((e) => e.kind === 'created');
        if (!created || created.actor_kind !== 'user') throw new Error(JSON.stringify(events));
      });

      await ctx.step('the owner session credential cannot create a goal → 403 goal_forbidden', async () => {
        const session = await ownerCredential(ctx, world, goal!.owner_session_id!);
        expectError(await session.post(GOALS, { goal_id: randomUUID(), brief: 'x' }, { params }), 403, 'goal_forbidden');
      });

      await ctx.step('an unknown or malformed goal id → 404 goal_not_found', async () => {
        expectError(await owner.get(GOAL, { params: { ...params, goalId: randomUUID() } }), 404, 'goal_not_found');
        expectError(await owner.get(GOAL, { params: { ...params, goalId: 'not-a-uuid' } }), 404, 'goal_not_found');
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'GOAL-2',
  {
    domain: 'goals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [R.create, R.criteria, R.activate, R.wait, R.answer, R.progress, R.verify, R.verdict, R.read],
  },
  async (ctx) => {
    const { project, world, owner } = await openWorld(ctx);
    const params = { projectId: project.id };
    try {
      const draft = await createGoal(owner, project.id, { criteria: undefined });
      const at = { params: { ...params, goalId: draft.goal_id } };
      const session = await ownerCredential(ctx, world, draft.owner_session_id!);
      let goal = draft;

      await ctx.step('the owner session sets 2 criteria on its draft → 200, criteria revision 1', async () => {
        const r = (await session.put(verb(R.criteria), { revision: goal.revision, criteria: ['The report is in Files', 'The owner signed off'] }, at)).status(200);
        goal = r.json<{ goal: Goal }>().goal;
        if (goal.criteria.length !== 2 || goal.criteria_revision !== 1) throw new Error(JSON.stringify(goal));
      });

      await ctx.step('a person cannot activate; the owner session activates → active', async () => {
        expectError(await owner.post(verb(R.activate), { revision: goal.revision, reason: 'x' }, at), 403, 'goal_forbidden');
        goal = (await session.post(verb(R.activate), { revision: goal.revision, reason: 'criteria are checkable' }, at)).status(200).json<{ goal: Goal }>().goal;
        if (goal.state !== 'active') throw new Error(goal.state);
      });

      await ctx.step('after activation the owner can no longer change the criteria → 403', async () => {
        expectError(await session.put(verb(R.criteria), { revision: goal.revision, criteria: ['easy'] }, at), 403, 'goal_forbidden');
      });

      await ctx.step('the owner session waits on a question → waiting_on_user', async () => {
        goal = (await session.post(verb(R.wait), { revision: goal.revision, question: 'Which region?' }, at)).status(200).json<{ goal: Goal }>().goal;
        if (goal.state !== 'waiting_on_user') throw new Error(goal.state);
        expectError(await session.post(verb(R.wait), { revision: goal.revision, question: 'x', chase_at: new Date(Date.now() + 60_000).toISOString() }, at), 409, 'goal_conflict');
      });

      await ctx.step('the person answers → active; the same answer_id again changes nothing; the session cannot answer → 403', async () => {
        const answerId = randomUUID();
        const first = (await owner.post(verb(R.answer), { answer_id: answerId, text: 'EU only' }, at)).status(200).json<{ goal: Goal }>().goal;
        if (first.state !== 'active') throw new Error(first.state);
        const again = (await owner.post(verb(R.answer), { answer_id: answerId, text: 'EU only' }, at)).status(200).json<{ goal: Goal }>().goal;
        if (again.revision !== first.revision) throw new Error('a repeated answer wrote again');
        expectError(await session.post(verb(R.answer), { answer_id: randomUUID(), text: 'x' }, at), 403, 'goal_forbidden');
        goal = again;
      });

      await ctx.step('progress reports met + evidence and never verifies; a path outside evidence/ → 422', async () => {
        const bad = await session.post(verb(R.progress), { revision: goal.revision, criteria: [{ id: 'c1', reported_met: true, evidence: '../GOAL.md' }] }, at);
        expectError(bad, 422, 'goal_invalid');
        goal = (await session.post(verb(R.progress), { revision: goal.revision, summary: 'drafted', criteria: [{ id: 'c1', reported_met: true, evidence: 'evidence/report.md' }, { id: 'c2', reported_met: true, evidence: 'evidence/signoff.md' }] }, at))
          .status(200).json<{ goal: Goal }>().goal;
        if (goal.criteria.some((c) => c.verified) || !goal.criteria.every((c) => c.reported_met)) throw new Error(JSON.stringify(goal.criteria));
      });

      await ctx.step('verification needs the evidence files to exist → 422 goal_invalid; state stays active', async () => {
        const r = await session.post(verb(R.verify), { revision: goal.revision }, at);
        expectError(r, 422, 'goal_invalid');
        if (!r.json<{ violations?: string[] }>().violations?.length) throw new Error('no violations');
        if ((await read(owner, project.id, goal.goal_id)).state !== 'active') throw new Error('state moved');
      });

      await ctx.step('neither the owner session nor a person can give a verdict → 403; the goal is not done', async () => {
        const results = [{ criterion_id: 'c1', result: 'pass', note: '' }, { criterion_id: 'c2', result: 'pass', note: '' }];
        expectError(await session.post(verb(R.verdict), { revision: goal.revision, results }, at), 403, 'goal_forbidden');
        expectError(await owner.post(verb(R.verdict), { revision: goal.revision, results }, at), 403, 'goal_forbidden');
        const back = await read(owner, project.id, goal.goal_id);
        if (back.state === 'done' || back.criteria.some((c) => c.verified)) throw new Error('forged done');
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'GOAL-3',
  {
    domain: 'goals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [R.create, R.read, R.list, R.edit, R.pause, R.resume],
  },
  async (ctx) => {
    const { team, project, world, owner } = await openWorld(ctx);
    const params = { projectId: project.id };
    try {
      const member = await team.addMember('member');
      await team.grantProjectRole(project.id, member.userId!, 'member');
      const assignee = await team.addMember('member');
      await team.grantProjectRole(project.id, assignee.userId!, 'member');
      const asMember = ctx.client.as(member);
      const asAssignee = ctx.client.as(assignee);
      const goal = await createGoal(owner, project.id, { assigned_user_id: assignee.userId });
      const at = { params: { ...params, goalId: goal.goal_id } };

      await ctx.step('a project member who is neither creator, assignee nor admin cannot see it → 404, and the list leaves it out', async () => {
        expectError(await asMember.get(GOAL, at), 404, 'goal_not_found');
        const listed = (await asMember.get(GOALS, { params })).status(200).json<{ goals: Goal[] }>().goals;
        if (listed.some((g) => g.goal_id === goal.goal_id)) throw new Error('listed to an outsider');
        expectError(await asMember.post(verb(R.pause), { revision: goal.revision }, at), 404, 'goal_not_found');
      });

      await ctx.step('the assigned person reads it with pause/stop/answer capabilities and pauses it → 200', async () => {
        const seen = await read(asAssignee, project.id, goal.goal_id);
        if (!seen.capabilities.pause || !seen.capabilities.answer || seen.capabilities.restart) throw new Error(JSON.stringify(seen.capabilities));
        const paused = (await asAssignee.post(verb(R.pause), { revision: seen.revision, reason: 'waiting for budget' }, at)).status(200).json<{ goal: Goal }>().goal;
        if (!paused.paused_at || paused.capabilities.pause || !paused.capabilities.resume) throw new Error(JSON.stringify(paused));
      });

      await ctx.step('the owner session cannot resume, pause or edit its goal → 403 goal_forbidden', async () => {
        const session = await ownerCredential(ctx, world, goal.owner_session_id!);
        const now = await read(owner, project.id, goal.goal_id);
        expectError(await session.post(verb(R.resume), { revision: now.revision }, at), 403, 'goal_forbidden');
        expectError(await session.patch(GOAL, { revision: now.revision, max_wakes_per_day: 48 }, at), 403, 'goal_forbidden');
        const sessionView = await read(session, project.id, goal.goal_id);
        if (Object.entries(sessionView.capabilities).some(([k, v]) => k !== 'read' && v)) throw new Error(`session capabilities ${JSON.stringify(sessionView.capabilities)}`);
      });

      await ctx.step('the creator resumes and edits the caps within bounds; above the hard cap → 422', async () => {
        const now = await read(owner, project.id, goal.goal_id);
        const resumed = (await owner.post(verb(R.resume), { revision: now.revision }, at)).status(200).json<{ goal: Goal }>().goal;
        if (resumed.paused_at) throw new Error('still paused');
        expectError(await owner.patch(GOAL, { revision: resumed.revision, max_wakes_per_day: 49 }, at), 422, 'goal_invalid');
        // The agent is an authorization decision: one without Files (My Kortix) is refused like on create.
        expectError(await owner.patch(GOAL, { revision: resumed.revision, agent: 'mykortix' }, at), 422, 'goal_invalid');
        const edited = (await owner.patch(GOAL, { revision: resumed.revision, max_wakes_per_day: 6, title: 'Publish the synthetic report v2' }, at)).status(200).json<{ goal: Goal & { max_wakes_per_day: number } }>().goal;
        if (edited.max_wakes_per_day !== 6 || edited.title !== 'Publish the synthetic report v2') throw new Error(JSON.stringify(edited));
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'GOAL-4',
  {
    domain: 'goals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [R.create, R.activate, R.pause, R.resume, R.progress, R.stop, R.restart, R.handover, R.read],
  },
  async (ctx) => {
    const { project, world, owner } = await openWorld(ctx);
    const params = { projectId: project.id };
    try {
      const created = await createGoal(owner, project.id);
      const at = { params: { ...params, goalId: created.goal_id } };
      const session = await ownerCredential(ctx, world, created.owner_session_id!);
      let goal = (await session.post(verb(R.activate), { revision: created.revision, reason: 'go' }, at)).status(200).json<{ goal: Goal }>().goal;

      await ctx.step('a stale revision → 409 goal_conflict carrying the goal as it is now', async () => {
        const r = await owner.post(verb(R.pause), { revision: goal.revision - 1 }, at);
        expectError(r, 409, 'goal_conflict');
        if (r.json<{ goal?: Goal }>().goal?.revision !== goal.revision) throw new Error(r.text());
      });

      await ctx.step('after a pause the owner session cannot write even with the current revision → 409', async () => {
        goal = (await owner.post(verb(R.pause), { revision: goal.revision }, at)).status(200).json<{ goal: Goal }>().goal;
        expectError(await session.post(verb(R.progress), { revision: goal.revision, summary: 'still going' }, at), 409, 'goal_conflict');
        goal = (await owner.post(verb(R.resume), { revision: goal.revision }, at)).status(200).json<{ goal: Goal }>().goal;
        (await session.post(verb(R.progress), { revision: goal.revision, summary: 'going again' }, at)).status(200);
        goal = await read(owner, project.id, goal.goal_id);
      });

      await ctx.step('stop → stopped; a retry with any revision → 200 stopped; the owner session is fenced → 409', async () => {
        goal = (await owner.post(verb(R.stop), { revision: goal.revision, reason: 'not needed' }, at)).status(200).json<{ goal: Goal }>().goal;
        if (goal.state !== 'stopped' || !goal.capabilities.restart) throw new Error(JSON.stringify(goal));
        const retried = (await owner.post(verb(R.stop), { revision: 1 }, at)).status(200).json<{ goal: Goal }>().goal;
        if (retried.state !== 'stopped' || retried.revision !== goal.revision) throw new Error(JSON.stringify(retried));
        expectError(await session.post(verb(R.handover), { revision: goal.revision, note: 'x' }, at), 409, 'goal_conflict');
      });

      await ctx.step('restart → active again (it has criteria); the session cannot restart → 403', async () => {
        expectError(await session.post(verb(R.restart), { revision: goal.revision }, at), 403, 'goal_forbidden');
        goal = (await owner.post(verb(R.restart), { revision: goal.revision }, at)).status(200).json<{ goal: Goal }>().goal;
        if (goal.state !== 'active') throw new Error(goal.state);
        expectError(await owner.post(verb(R.restart), { revision: goal.revision }, at), 409, 'goal_conflict');
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'GOAL-5',
  {
    domain: 'goals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [
      R.create,
      R.activate,
      R.events,
      'GET /v1/projects/:projectId/sessions/:sessionId/reminders',
      'PATCH /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId',
      'POST /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId/run',
    ],
  },
  async (ctx) => {
    const { project, world, owner } = await openWorld(ctx);
    const params = { projectId: project.id };
    try {
      let created = await createGoal(owner, project.id);
      const at = { params: { ...params, goalId: created.goal_id } };
      const session = await ownerCredential(ctx, world, created.owner_session_id!);
      const reminders = { params: { ...params, sessionId: created.owner_session_id! } };
      let heartbeat = '';

      await ctx.step('a create retry with the same goal_id finishes the steps an earlier attempt left; the owner session stays the same', async () => {
        const retried = await createGoal(owner, project.id, { goal_id: created.goal_id });
        if (retried.owner_session_id !== created.owner_session_id) throw new Error('a retry named another owner');
        created = retried;
      });

      let expected = '';
      await ctx.step('the goal has exactly one heartbeat loop on its owner session: off while draft; once active it is on, or stays off while setup is unfinished (no Drive storage)', async () => {
        const list = (await owner.get('/v1/projects/:projectId/sessions/:sessionId/reminders', reminders)).status(200)
          .json<{ reminders: Array<{ id: string; state: string; prompt: string }> }>().reminders.filter((r) => r.prompt.includes(`goal ${created.goal_id}`));
        if (list.length !== 1 || list[0]!.state !== 'paused') throw new Error(JSON.stringify(list));
        heartbeat = list[0]!.id;
        const active = (await session.post(verb(R.activate), { revision: created.revision, reason: 'go' }, at)).status(200).json<{ goal: Goal }>().goal;
        expected = active.blocked_reason === 'setup' ? 'paused' : 'active';
        const after = (await owner.get('/v1/projects/:projectId/sessions/:sessionId/reminders', reminders)).json<{ reminders: Array<{ id: string; state: string }> }>().reminders;
        if (after.find((r) => r.id === heartbeat)?.state !== expected) throw new Error(`expected ${expected}: ${JSON.stringify(after)}`);
      });

      await ctx.step('the owner session cannot pause, run or delete its goal heartbeat → 403 goal_heartbeat, and the loop is unchanged', async () => {
        const one = { params: { ...reminders.params, reminderId: heartbeat } };
        expectError(await session.patch('/v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId', { enabled: false }, one), 403, 'goal_heartbeat');
        expectError(await session.post('/v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId/run', {}, one), 403, 'goal_heartbeat');
        expectError(await session.del('/v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId', one), 403, 'goal_heartbeat');
        const still = (await owner.get('/v1/projects/:projectId/sessions/:sessionId/reminders', reminders)).json<{ reminders: Array<{ id: string; state: string }> }>().reminders;
        if (still.find((r) => r.id === heartbeat)?.state !== expected) throw new Error('the heartbeat changed');
      });

      await ctx.step('the session may still manage a loop of its own that is no goal heartbeat → 201 then 200', async () => {
        const own = (await session.post('/v1/projects/:projectId/sessions/:sessionId/reminders', { prompt: 'Check the inbox', in: '1h' }, reminders)).status(201).json<{ id: string }>();
        (await session.del('/v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId', { params: { ...reminders.params, reminderId: own.id } })).status(200);
      });

      await ctx.step('the events log every move with its actor: created, activated by the session', async () => {
        const events = (await owner.get(path(R.events), at)).status(200).json<{ events: Array<{ kind: string; actor_kind: string; actor_id: string | null }> }>().events;
        const activated = events.find((e) => e.kind === 'activated');
        if (activated?.actor_kind !== 'session' || activated.actor_id !== created.owner_session_id) throw new Error(JSON.stringify(events));
      });
    } finally {
      await world.close();
    }
  },
);
