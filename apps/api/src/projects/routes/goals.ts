/**
 * Goals: `/v1/workspaces/:workspaceId/goals/*`, legacy `/v1/projects/:workspaceId/goals/*` (project flag `goals`).
 *
 * The routes derive the caller (`GoalActor`) from the credential and hand
 * plain values to `projects/goals/service.ts`, which owns every rule. A
 * session credential is a session; a browser login or a PAT not bound to a
 * session is a person. No body field names the actor.
 *
 * Wire contract: @kortix/api-contract goals.ts. Errors: `403 goal_forbidden`,
 * `404 goal_not_found`, `409 goal_conflict` (with the current goal), `422
 * goal_invalid` (with `violations`). Flag off: `403 feature_disabled`.
 */
import { workspaceIdParam } from '../../shared/route-params';
import { createRoute, z } from '@hono/zod-openapi';
import {
  ActivateGoalRequestSchema,
  AnswerGoalRequestSchema,
  CreateGoalRequestSchema,
  EditGoalRequestSchema,
  GoalControlRequestSchema,
  GoalErrorSchema,
  GoalEventsResponseSchema,
  GoalListResponseSchema,
  GoalProgressRequestSchema,
  GoalResponseSchema,
  GoalVerdictRequestSchema,
  HandoverGoalRequestSchema,
  RequestVerificationRequestSchema,
  SetGoalCriteriaRequestSchema,
  WaitGoalRequestSchema,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accessAt, getDrive, groupIdsOf, listFolderGrants } from '../../drives/service';
import { folderAccessAtLeast } from '../../drives/folders';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json, lenientBody } from '../../openapi';
import { isUuid } from '../../shared/validate';
import type { AppEnv } from '../../types';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { projectsApp } from '../lib/app';
import { NO_FILES_AGENTS, isGoalManager, goalAgentCandidates, type GoalActor } from '../goals/rules';
import { serializeGoal, serializeGoalError, serializeGoalEvent } from '../goals/serialize';
import * as goals from '../goals/service';
import { GoalError, getGoal, listGoalEvents, listGoals, type GoalRow } from '../goals/store';

type GoalContextC = Context<AppEnv>;
const projectParams = z.object({ workspaceId: z.string() });
const goalParams = projectParams.extend({ goalId: z.string() });
const GOAL_ERRORS = { 403: json(GoalErrorSchema, 'goal_forbidden or feature_disabled'), 404: json(GoalErrorSchema, 'goal_not_found'), 409: json(GoalErrorSchema, 'goal_conflict: the goal as it is now'), 422: json(GoalErrorSchema, 'goal_invalid, with violations') };

interface Scope {
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;
  actor: GoalActor;
}

async function isProjectAdmin(c: GoalContextC, projectId: string): Promise<boolean> {
  try {
    return Boolean(await loadProjectForUser(c, projectId, 'write'));
  } catch (err) {
    if (err instanceof HTTPException && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}

/** The project, the flag, and who calls. A Response when the request ends here. */
async function scopeOf(c: GoalContextC): Promise<Scope | Response> {
  const projectId = workspaceIdParam(c) ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'goal_not_found', message: 'Not found.' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'goals');
  if (gate) return gate;
  const bound = callerKortixSessionId(c);
  const actor: GoalActor =
    isProjectSessionPrincipal(c) && bound
      ? { kind: 'session', sessionId: bound, userId: loaded.userId }
      : { kind: 'user', userId: loaded.userId, isAdmin: await isProjectAdmin(c, projectId) };
  return { loaded, actor };
}

/** May this caller read the goal? A session: it is or was its owner or verifier. A person: a manager, or read access to its folder in Files. */
async function mayRead(goal: GoalRow, actor: GoalActor, folderReader: (goal: GoalRow) => Promise<boolean>): Promise<boolean> {
  if (actor.kind === 'session') return goal.sessions.some((s) => s.id === actor.sessionId);
  if (actor.kind !== 'user') return false;
  return isGoalManager(goal, actor) || folderReader(goal);
}

/** Drive ACL read of each goal's folder, with the grants read once per drive. */
function folderReaderFor(userId: string, accountId: string): (goal: GoalRow) => Promise<boolean> {
  const grantsByDrive = new Map<string, Promise<Awaited<ReturnType<typeof listFolderGrants>> | null>>();
  let groups: Promise<Set<string>> | null = null;
  return async (goal) => {
    if (!grantsByDrive.has(goal.driveId)) {
      grantsByDrive.set(goal.driveId, getDrive(goal.driveId).then((d) => (d ? listFolderGrants(d) : null)));
    }
    const grants = await grantsByDrive.get(goal.driveId)!;
    if (!grants) return false;
    groups ??= groupIdsOf(userId, accountId);
    return folderAccessAtLeast(accessAt(goal.folder, grants, { userId, groupIds: await groups }), 'read');
  };
}

function errorResponse(c: GoalContextC, error: unknown, actor: GoalActor): Response {
  if (error instanceof GoalError) return c.json(serializeGoalError(error, actor), error.status);
  throw error;
}

async function readableGoal(c: GoalContextC, scope: Scope): Promise<GoalRow | Response> {
  const goalId = c.req.param('goalId') ?? '';
  const goal = isUuid(goalId) ? await getGoal(scope.loaded.row.projectId, goalId) : null;
  if (!goal || !(await mayRead(goal, scope.actor, folderReaderFor(scope.loaded.userId, scope.loaded.row.accountId)))) {
    return c.json({ error: 'goal_not_found' as const, message: 'Goal not found.' }, 404);
  }
  return goal;
}

async function parseBody<T>(c: GoalContextC, schema: z.ZodType<T>): Promise<T | Response> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return c.json(
    { error: 'goal_invalid' as const, message: 'The request body is invalid.', violations: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) },
    422,
  );
}

type Action = (ctx: goals.GoalContext, goalId: string, body: never) => Promise<GoalRow | { goal: GoalRow; deduped: boolean }>;

/** One `POST /goals/:id/<verb>` (or PUT/PATCH): scope, readable goal, body, service call, the goal back. */
function goalWrite<T>(
  schema: z.ZodType<T>,
  run: (ctx: goals.GoalContext, goalId: string, body: T) => Promise<GoalRow | { goal: GoalRow; deduped: boolean }>,
  /** An authorization decision the body carries; a Response ends the request before the write. */
  guard?: (c: GoalContextC, scope: Exclude<Awaited<ReturnType<typeof scopeOf>>, Response>, body: T) => Promise<Response | void>,
) {
  return async (c: GoalContextC) => {
    const scope = await scopeOf(c);
    if (scope instanceof Response) return scope;
    const goal = await readableGoal(c, scope);
    if (goal instanceof Response) return goal;
    const body = await parseBody(c, schema);
    if (body instanceof Response) return body;
    const refused = guard ? await guard(c, scope, body) : undefined;
    if (refused) return refused;
    try {
      const out = await run({ project: scope.loaded.row, actor: scope.actor }, goal.goalId, body);
      const row = 'goal' in out ? out.goal : out;
      return c.json({ goal: serializeGoal(row, scope.actor) }, 200);
    } catch (error) {
      return errorResponse(c, error, scope.actor);
    }
  };
}

const ACTIONS: Array<{ verb: string; summary: string; who: string; schema: z.ZodObject<z.ZodRawShape>; run: Action }> = [
  { verb: 'activate', summary: 'Activate a draft goal', who: 'The owner session.', schema: ActivateGoalRequestSchema, run: goals.activateGoal as Action },
  { verb: 'wait', summary: 'Wait on the assigned person', who: 'The owner session. The heartbeat stops until the answer, or until `chase_at`.', schema: WaitGoalRequestSchema, run: goals.waitGoal as Action },
  { verb: 'answer', summary: 'Answer a goal', who: 'Its creator, assigned person or a project admin. Idempotent on `answer_id`.', schema: AnswerGoalRequestSchema, run: goals.answerGoal as Action },
  { verb: 'progress', summary: 'Report progress on a goal', who: 'The owner session. Reports only; never verifies.', schema: GoalProgressRequestSchema, run: goals.reportProgress as Action },
  { verb: 'request-verification', summary: 'Ask for an independent verification', who: 'The owner session; every criterion reported met with an evidence file.', schema: RequestVerificationRequestSchema, run: goals.requestVerification as Action },
  { verb: 'verdict', summary: 'Give the verdict of a verification', who: 'The current verifier session; one result per current criterion.', schema: GoalVerdictRequestSchema, run: goals.giveVerdict as Action },
  { verb: 'handover', summary: 'Hand a goal to a fresh owner session', who: 'The owner session.', schema: HandoverGoalRequestSchema, run: goals.handoverGoal as Action },
  { verb: 'pause', summary: 'Pause a goal', who: 'Its creator, assigned person or a project admin.', schema: GoalControlRequestSchema, run: goals.pauseGoal as Action },
  { verb: 'resume', summary: 'Resume a goal', who: 'Its creator, assigned person or a project admin.', schema: GoalControlRequestSchema, run: goals.resumeGoal as Action },
  { verb: 'stop', summary: 'Stop a goal', who: 'Its creator, assigned person or a project admin. A retry on a stopped goal finishes its cleanup.', schema: GoalControlRequestSchema, run: goals.stopGoal as Action },
  { verb: 'restart', summary: 'Restart a stopped goal', who: 'Its creator, assigned person or a project admin.', schema: GoalControlRequestSchema, run: goals.restartGoal as Action },
];

/**
 * Mount a handler that answers with the contract's own types (`serializeGoal`
 * returns `Goal`) and `GoalError` bodies. The route's typed-response check
 * cannot follow a shared helper's Response, so it is skipped here.
 */
function handler(fn: (c: GoalContextC) => Promise<Response>): never {
  return fn as never;
}

export function registerGoalRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/goals',
      tags: ['goals'],
      summary: 'List the goals of a project',
      description: 'Goals the caller may read. A session sees only goals it owns or verifies (or did). Flag `goals`.',
      ...auth,
      request: { params: projectParams, query: z.object({ owner_session_id: z.string().optional(), verifier_session_id: z.string().optional() }) },
      responses: { 200: json(GoalListResponseSchema, 'The goals'), ...errors(403, 404) },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const ownerFilter = c.req.query('owner_session_id');
      const verifierFilter = c.req.query('verifier_session_id');
      const rows = await listGoals(scope.loaded.row.projectId);
      const reader = folderReaderFor(scope.loaded.userId, scope.loaded.row.accountId);
      const visible: GoalRow[] = [];
      for (const row of rows) {
        if (ownerFilter && row.ownerSessionId !== ownerFilter) continue;
        if (verifierFilter && row.verifierSessionId !== verifierFilter) continue;
        if (await mayRead(row, scope.actor, reader)) visible.push(row);
      }
      return c.json({ goals: visible.map((row) => serializeGoal(row, scope.actor)) }, 200);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/goals',
      tags: ['goals'],
      summary: 'Create a goal',
      description:
        'A person, or a chat session for the person it works for, creates a goal in that person\'s folder in Files. A goal\'s own owner or verifier session cannot. `goal_id` is the idempotency key: a retry returns the same goal and finishes any create step a failed attempt left. ' +
        'The API creates the idle owner session, GOAL.md and log.md, the heartbeat, and queues the first prompt. Needs `project.session.start` and an agent with Files. Flag `goals`.',
      ...auth,
      request: { params: projectParams, body: { content: { 'application/json': { schema: lenientBody(CreateGoalRequestSchema.shape) } } } },
      responses: { 201: json(GoalResponseSchema, 'The goal'), ...errors(400), ...GOAL_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const body = await parseBody(c, CreateGoalRequestSchema);
      if (body instanceof Response) return body;
      const { loaded } = scope;
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, PROJECT_ACTIONS.PROJECT_SESSION_START);
      let resolved = await resolveAndAuthorizeAgent(c, loaded, loaded.row.projectId, body.agent ?? null);
      // No agent named and the default has no Files (My Kortix): the first agent the caller may run that has them.
      if (!body.agent && (!resolved.agentName || NO_FILES_AGENTS.has(resolved.agentName))) {
        for (const name of goalAgentCandidates(await goals.goalAgentConfig(loaded.row))) {
          const tried = await resolveAndAuthorizeAgent(c, loaded, loaded.row.projectId, name).catch(() => null);
          if (tried?.agentName) {
            resolved = tried;
            break;
          }
        }
      }
      const agent = resolved.agentName ?? body.agent ?? null;
      if (!agent) return c.json({ error: 'goal_invalid' as const, message: 'This project has no agent with Files that you may run. Add one, or name it in `agent`.' }, 422);
      if (NO_FILES_AGENTS.has(agent)) return c.json({ error: 'goal_invalid' as const, message: `${agent} cannot work a goal: it has no Files. Pick another agent.` }, 422);
      try {
        const row = await goals.createGoal({ project: loaded.row, actor: scope.actor }, { ...body, agent });
        return c.json({ goal: serializeGoal(row, scope.actor) }, 201);
      } catch (error) {
        return errorResponse(c, error, scope.actor);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/goals/{goalId}',
      tags: ['goals'],
      summary: 'Read a goal',
      description: 'The goal and what the caller may do on it (`capabilities`). Flag `goals`.',
      ...auth,
      request: { params: goalParams },
      responses: { 200: json(GoalResponseSchema, 'The goal'), ...GOAL_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const goal = await readableGoal(c, scope);
      if (goal instanceof Response) return goal;
      return c.json({ goal: serializeGoal(goal, scope.actor) }, 200);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/goals/{goalId}/events',
      tags: ['goals'],
      summary: "Read a goal's events",
      description: 'Newest first, 50 per page. Pass `next_cursor` back as `cursor`. Flag `goals`.',
      ...auth,
      request: { params: goalParams, query: z.object({ cursor: z.string().optional() }) },
      responses: { 200: json(GoalEventsResponseSchema, 'The events'), ...GOAL_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const goal = await readableGoal(c, scope);
      if (goal instanceof Response) return goal;
      const page = await listGoalEvents(goal.goalId, c.req.query('cursor') ?? null);
      return c.json({ events: page.rows.map(serializeGoalEvent), next_cursor: page.next }, 200);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}/goals/{goalId}',
      tags: ['goals'],
      summary: 'Edit a goal',
      description: 'Title, assigned person, space, agent, caps and heartbeat. Its creator, assigned person or a project admin. Flag `goals`.',
      ...auth,
      request: { params: goalParams, body: { content: { 'application/json': { schema: lenientBody(EditGoalRequestSchema.shape) } } } },
      responses: { 200: json(GoalResponseSchema, 'The goal'), ...GOAL_ERRORS },
    }),
    handler(
      goalWrite(EditGoalRequestSchema, goals.editGoal, async (c, scope, body) => {
        // The agent a goal runs is an authorization decision: a person may point a goal only at
        // an agent they may run, and one with Files. The same two gates `POST /goals` applies.
        const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
        if (!agent) return;
        if (NO_FILES_AGENTS.has(agent)) return c.json({ error: 'goal_invalid' as const, message: `${agent} cannot work a goal: it has no Files. Pick another agent.` }, 422);
        const resolved = await resolveAndAuthorizeAgent(c, scope.loaded, scope.loaded.row.projectId, agent).catch(() => null);
        if (resolved?.agentName !== agent) return c.json({ error: 'goal_forbidden' as const, message: `You may not run the ${agent} agent.` }, 403);
      }),
    ),
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/goals/{goalId}/criteria',
      tags: ['goals'],
      summary: "Set a goal's done criteria",
      description:
        'A person (creator, assigned person, project admin) in any open state: bumps `criteria_revision`, clears `verified`, and makes a running verification stale. ' +
        'The owner session while the goal is a draft. Flag `goals`.',
      ...auth,
      request: { params: goalParams, body: { content: { 'application/json': { schema: lenientBody(SetGoalCriteriaRequestSchema.shape) } } } },
      responses: { 200: json(GoalResponseSchema, 'The goal'), ...GOAL_ERRORS },
    }),
    handler(goalWrite(SetGoalCriteriaRequestSchema, goals.setCriteria)),
  );

  for (const action of ACTIONS) {
    projectsApp.openapi(
      createRoute({
        method: 'post',
        path: `/{workspaceId}/goals/{goalId}/${action.verb}`,
        tags: ['goals'],
        summary: action.summary,
        description: `${action.who} Flag \`goals\`.`,
        ...auth,
        request: { params: goalParams, body: { content: { 'application/json': { schema: lenientBody(action.schema.shape) } } } },
        responses: { 200: json(GoalResponseSchema, 'The goal'), ...GOAL_ERRORS },
      }),
      handler(goalWrite(action.schema, action.run as never)),
    );
  }
}
