// A team's shared task list (flag `agent_teams`, `@kortix/api-contract/multi-agent`).
// Logic lives in `projects/team-tasks/service.ts`.
//
// Who may call: the lead session's own credential, a teammate's own
// credential (its `team_lead` is the lead), or a person who can see the lead
// (reads) or may prompt it (writes). Every route answers 403
// `feature_disabled` while the project has the flag off.
import { createRoute, z } from '@hono/zod-openapi';
import {
  SessionTaskCreateBodySchema,
  SessionTaskSchema,
  SessionTaskUpdateBodySchema,
} from '@kortix/api-contract/multi-agent';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { mayPromptSessions } from '../../notifications/access';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { projectsApp } from '../lib/app';
import { sessionIsTombstoned } from '../lib/session-visibility';
import { loadPeerSession } from '../peer-messages/service';
import {
  AGENT_TEAMS_FLAG,
  TeamTaskError,
  createTask,
  deleteTask,
  getTask,
  isTeammateOf,
  listTasks,
  teamHandle,
  updateTask,
  type TeamCaller,
} from '../team-tasks/service';

const LeadParams = z.object({ projectId: z.string().uuid(), sessionId: z.string().min(1).max(128) });
const TaskParams = LeadParams.extend({ seq: z.coerce.number().int().positive() });

/** The lead, the flag, and who calls (`TeamCaller`). */
async function authorizeTeam(c: Context, projectId: string, leadSessionId: string, mode: 'read' | 'write') {
  const fail = (status: 403 | 404, error: string, code?: string) =>
    ({ ok: false as const, response: c.json({ error, ...(code ? { code } : {}) }, status) });
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return fail(404, 'Not found');
  const disabled = requireFeatureFlag(c, loaded.row.metadata, AGENT_TEAMS_FLAG);
  if (disabled) return { ok: false as const, response: disabled };
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  const callerSessionId = callerKortixSessionId(c);
  if (isProjectSessionPrincipal(c)) {
    // A session token: the lead itself, or one of its teammates.
    const self = callerSessionId ? await loadPeerSession(callerSessionId) : null;
    const lead = callerSessionId === leadSessionId ? self : await loadPeerSession(leadSessionId);
    if (!self || !lead || lead.projectId !== projectId || sessionIsTombstoned(lead)) return fail(404, 'Session not found');
    const role = self.sessionId === leadSessionId ? 'lead' : isTeammateOf(self.metadata, leadSessionId) ? 'teammate' : null;
    if (!role) return fail(403, 'Only the lead and its teammates use this task list', 'not_in_team');
    const caller: TeamCaller = { kind: 'session', sessionId: self.sessionId, handle: teamHandle(self), role };
    return { ok: true as const, lead, caller };
  }
  const visible = await loadVisibleSession(loaded, leadSessionId, c.get('sessionId') ?? null, callerSessionId);
  if (!visible || sessionIsTombstoned(visible.row)) return fail(404, 'Session not found');
  if (mode === 'write' && !(await mayPromptSessions(loaded.userId, loaded.row.accountId, [leadSessionId])).has(leadSessionId)) {
    return fail(403, 'You may not prompt this session', 'cannot_prompt');
  }
  const caller: TeamCaller = { kind: 'person', userId: loaded.userId };
  return { ok: true as const, lead: visible.row, caller };
}

function taskError(c: Context, err: unknown) {
  // Each route declares the statuses it can answer; the service picks one of them.
  if (err instanceof TeamTaskError) return c.json({ error: err.message, code: err.code }, err.status) as never;
  throw err;
}

export function registerTeamTasksRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/tasks', tags: ['sessions'],
    summary: "List a team's tasks",
    description: '`sessionId` is the lead. Tasks in number order; `blocked` is true while a task in `blocked_by` is not completed. Flag `agent_teams`.',
    ...auth,
    request: { params: LeadParams },
    responses: { 200: json(z.object({ tasks: z.array(SessionTaskSchema) }), 'The tasks'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const access = await authorizeTeam(c, projectId, sessionId, 'read');
    if (!access.ok) return access.response;
    return c.json({ tasks: await listTasks(sessionId) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/sessions/{sessionId}/tasks', tags: ['sessions'],
    summary: 'Add a task to a team',
    description: '`owner` is a teammate handle; `blocked_by` lists task numbers of this team. Flag `agent_teams`.',
    ...auth,
    request: { params: LeadParams, body: { required: true, content: { 'application/json': { schema: SessionTaskCreateBodySchema } } } },
    responses: { 201: json(SessionTaskSchema, 'The task'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const access = await authorizeTeam(c, projectId, sessionId, 'write');
    if (!access.ok) return access.response;
    try {
      const task = await createTask({
        lead: access.lead,
        body: c.req.valid('json'),
        createdBySessionId: access.caller.kind === 'session' ? access.caller.sessionId : null,
      });
      return c.json(task, 201);
    } catch (err) {
      return taskError(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/tasks/{seq}', tags: ['sessions'],
    summary: 'Read one task of a team',
    ...auth,
    request: { params: TaskParams },
    responses: { 200: json(SessionTaskSchema, 'The task'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, sessionId, seq } = c.req.valid('param');
    const access = await authorizeTeam(c, projectId, sessionId, 'read');
    if (!access.ok) return access.response;
    try {
      return c.json(await getTask(sessionId, seq), 200);
    } catch (err) {
      return taskError(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'patch', path: '/{projectId}/sessions/{sessionId}/tasks/{seq}', tags: ['sessions'],
    summary: 'Change or claim a task',
    description:
      '`claim: true` takes the task for the calling session in one step: only a pending, unowned task whose blockers are all completed. ' +
      'The loser of a race gets `409 task_taken`; a blocked task gives `409 task_blocked`. Flag `agent_teams`.',
    ...auth,
    request: { params: TaskParams, body: { required: true, content: { 'application/json': { schema: SessionTaskUpdateBodySchema } } } },
    responses: { 200: json(SessionTaskSchema, 'The task'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, sessionId, seq } = c.req.valid('param');
    const access = await authorizeTeam(c, projectId, sessionId, 'write');
    if (!access.ok) return access.response;
    try {
      return c.json(await updateTask({ lead: access.lead, seq, body: c.req.valid('json'), caller: access.caller }), 200);
    } catch (err) {
      return taskError(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/sessions/{sessionId}/tasks/{seq}', tags: ['sessions'],
    summary: 'Delete a task of a team',
    description: 'Tasks that waited for it no longer do. Flag `agent_teams`.',
    ...auth,
    request: { params: TaskParams },
    responses: { 200: json(z.object({ deleted: z.literal(true) }), 'Deleted'), ...errors(400, 403, 404, 409) },
  }), async (c) => {
    const { projectId, sessionId, seq } = c.req.valid('param');
    const access = await authorizeTeam(c, projectId, sessionId, 'write');
    if (!access.ok) return access.response;
    try {
      await deleteTask(sessionId, seq);
      return c.json({ deleted: true as const }, 200);
    } catch (err) {
      return taskError(c, err);
    }
  });
}
