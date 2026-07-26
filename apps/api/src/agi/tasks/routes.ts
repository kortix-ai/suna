/**
 * AGI tasks — the HTTP surface (docs/specs/2026-07-26-agi-autonomous-operations.md §5).
 *
 * Registered as an import side effect on `agiApp`, which is mounted at
 * /v1/projects, so `/{projectId}/agi/tasks` is the full
 * /v1/projects/{projectId}/agi/tasks.
 *
 * Every handler opens with `requireAgiProject` — floor, leaf, then the `agi`
 * gate, in that order — and every query is workspace-scoped, so a task id from
 * another workspace is indistinguishable from one that does not exist.
 */
import { agiApp } from '../app';
import { requireAgiProject } from '../access';
import {
  idsNeedingResolution,
  parseClaimBody,
  parseCreateTaskBody,
  parsePatchTaskBody,
  parseReleaseBody,
} from './input';
import {
  AgiTaskBodySchema,
  AgiTaskClaimResultSchema,
  AgiTaskCreateResultSchema,
  AgiTaskDetailSchema,
  AgiTaskListSchema,
  AgiTaskReleaseResultSchema,
  AgiTaskResultSchema,
} from './schemas';
import {
  claimTask,
  createTask,
  listTasks,
  loadChildren,
  loadTask,
  loadTasksByIds,
  patchTask,
  releaseTask,
  resolveTaskIds,
  wouldCreateParentCycle,
  type TaskListFilters,
} from './store';
import {
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  TASK_RELATION_CAP,
  decodeTaskCursor,
  encodeTaskCursor,
  isTerminalTaskStatus,
  orderBlockers,
  parseAssigneeFilter,
  parseBoundedInteger,
  parseClaimFilter,
  parseNullableFilter,
  parseStatusFilter,
  serializeAgiTask,
} from './wire';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { UUID_V4_REGEX, readBody } from '../../projects/lib/serializers';
import { createRoute, z } from '@hono/zod-openapi';

const ProjectParams = z.object({ projectId: z.string() });
const TaskParams = z.object({ projectId: z.string(), taskId: z.string() });

// ─── GET /:projectId/agi/tasks ──────────────────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agi/tasks',
    tags: ['agi'],
    summary: 'GET /:projectId/agi/tasks',
    ...auth,
    request: {
      params: ProjectParams,
      // Declared as free-form strings so a bad value produces this route's
      // `Invalid <param>` envelope rather than the shared zod-failure one.
      query: z
        .object({
          status: z.string(),
          goal: z.string(),
          project: z.string(),
          assignee: z.string(),
          parent: z.string(),
          blocked_by: z.string(),
          trigger: z.string(),
          claim: z.string(),
          limit: z.string(),
          cursor: z.string(),
        })
        .partial(),
    },
    responses: {
      200: json(AgiTaskListSchema, 'Tasks'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const prelude = await requireAgiProject(c, projectId, 'read', PROJECT_ACTIONS.PROJECT_READ);
    if (!prelude.ok) return prelude.response;

    const query = c.req.query() as Record<string, string>;

    const status = parseStatusFilter(query.status);
    if (!status) return c.json({ error: 'Invalid status' }, 400);

    const limit = parseBoundedInteger(query.limit, {
      min: 1,
      max: TASK_LIST_MAX_LIMIT,
      fallback: TASK_LIST_DEFAULT_LIMIT,
    });
    if (limit === null) return c.json({ error: 'Invalid limit' }, 400);

    const filters: TaskListFilters = { status, limit };

    if (query.goal !== undefined) {
      const goal = parseNullableFilter(query.goal);
      if (!goal) return c.json({ error: 'Invalid goal' }, 400);
      filters.goal = goal;
    }
    if (query.project !== undefined) {
      const project = parseNullableFilter(query.project);
      if (!project) return c.json({ error: 'Invalid project' }, 400);
      filters.project = project;
    }
    if (query.assignee !== undefined) {
      const assignee = parseAssigneeFilter(query.assignee);
      if (!assignee) return c.json({ error: 'Invalid assignee' }, 400);
      filters.assignee = assignee;
    }
    if (query.parent !== undefined) {
      const parent = parseNullableFilter(query.parent);
      if (!parent || (parent.kind === 'value' && !UUID_V4_REGEX.test(parent.value))) {
        return c.json({ error: 'Invalid parent' }, 400);
      }
      filters.parent = parent;
    }
    if (query.blocked_by !== undefined) {
      if (!UUID_V4_REGEX.test(query.blocked_by)) return c.json({ error: 'Invalid blocked_by' }, 400);
      filters.blockedBy = query.blocked_by;
    }
    if (query.trigger !== undefined) {
      if (query.trigger === '') return c.json({ error: 'Invalid trigger' }, 400);
      filters.trigger = query.trigger;
    }
    if (query.claim !== undefined) {
      const claim = parseClaimFilter(query.claim);
      if (!claim) return c.json({ error: 'Invalid claim' }, 400);
      filters.claim = claim;
    }
    if (query.cursor !== undefined) {
      const cursor = decodeTaskCursor(query.cursor);
      if (!cursor) return c.json({ error: 'Invalid cursor' }, 400);
      filters.cursor = cursor;
    }

    const rows = await listTasks(projectId, filters);
    const now = new Date();
    return c.json({
      tasks: rows.map((row) => serializeAgiTask(row, now)),
      // A short page is the last page: a cursor here would promise a next page
      // that does not exist.
      next_cursor: rows.length < limit ? null : encodeTaskCursor(rows[rows.length - 1]),
    });
  },
);

// ─── GET /:projectId/agi/tasks/:taskId ──────────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agi/tasks/{taskId}',
    tags: ['agi'],
    summary: 'GET /:projectId/agi/tasks/:taskId',
    ...auth,
    request: { params: TaskParams },
    responses: {
      200: json(AgiTaskDetailSchema, 'Task with children and blockers'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const taskId = c.req.param('taskId');
    const prelude = await requireAgiProject(c, projectId, 'read', PROJECT_ACTIONS.PROJECT_READ);
    if (!prelude.ok) return prelude.response;

    // A non-uuid would make Postgres raise 22P02 and surface as an opaque 500.
    if (!UUID_V4_REGEX.test(taskId)) return c.json({ error: 'Not found' }, 404);

    const task = await loadTask(projectId, taskId);
    if (!task) return c.json({ error: 'Not found' }, 404);

    const [children, blockerRows] = await Promise.all([
      loadChildren(projectId, taskId, TASK_RELATION_CAP),
      loadTasksByIds(projectId, task.blockedBy, TASK_RELATION_CAP),
    ]);
    // R-17: a cancelled blocker comes back like any other and the edge stays.
    // The API never prunes blocked_by, so an id that no longer resolves is
    // reported as missing rather than quietly dropped.
    const { blockers, missing } = orderBlockers(task.blockedBy, blockerRows);

    const now = new Date();
    return c.json({
      task: serializeAgiTask(task, now),
      children: children.map((row) => serializeAgiTask(row, now)),
      blockers: blockers.map((row) => serializeAgiTask(row, now)),
      missing_blockers: missing,
    });
  },
);

// ─── POST /:projectId/agi/tasks ─────────────────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/tasks',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/tasks',
    ...auth,
    request: {
      params: ProjectParams,
      body: { content: { 'application/json': { schema: AgiTaskBodySchema } } },
    },
    responses: {
      200: json(AgiTaskCreateResultSchema, 'Existing task (deduped on origin_fingerprint)'),
      201: json(AgiTaskCreateResultSchema, 'Created'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    const parsed = parseCreateTaskBody(await readBody(c));
    if (!parsed.ok) return c.json(parsed.error, 400);
    const fields = parsed.value;

    const resolved = await resolveTaskIds(projectId, idsNeedingResolution(fields));
    if (fields.parentId && !resolved.has(fields.parentId)) {
      return c.json({ error: 'parent_id does not resolve in this workspace' }, 400);
    }
    if (fields.blockedBy.some((id) => !resolved.has(id))) {
      return c.json(
        { error: 'blocked_by contains an unknown task', code: 'unknown_blocker' },
        400,
      );
    }

    const { row, created } = await createTask({ workspaceId: projectId, ...fields });
    // `created` is in the body as well as the status code so a client can tell a
    // create from a fingerprint dedupe without inspecting the transport.
    return c.json({ task: serializeAgiTask(row), created }, created ? 201 : 200);
  },
);

// ─── PATCH /:projectId/agi/tasks/:taskId ────────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/agi/tasks/{taskId}',
    tags: ['agi'],
    summary: 'PATCH /:projectId/agi/tasks/:taskId',
    ...auth,
    request: {
      params: TaskParams,
      body: { content: { 'application/json': { schema: AgiTaskBodySchema } } },
    },
    responses: {
      200: json(AgiTaskResultSchema, 'Updated task'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const taskId = c.req.param('taskId');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    if (!UUID_V4_REGEX.test(taskId)) return c.json({ error: 'Not found' }, 404);
    const existing = await loadTask(projectId, taskId);
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const parsed = parsePatchTaskBody(await readBody(c));
    if (!parsed.ok) return c.json(parsed.error, 400);
    const patch = parsed.value;

    if (patch.blockedBy?.includes(taskId)) {
      return c.json({ error: 'A task cannot block itself', code: 'self_blocker' }, 400);
    }

    const resolved = await resolveTaskIds(
      projectId,
      idsNeedingResolution({ parentId: patch.parentId, blockedBy: patch.blockedBy }),
    );
    if (patch.parentId && !resolved.has(patch.parentId)) {
      return c.json({ error: 'parent_id does not resolve in this workspace' }, 400);
    }
    if (patch.blockedBy?.some((id) => !resolved.has(id))) {
      return c.json({ error: 'blocked_by contains an unknown task', code: 'unknown_blocker' }, 400);
    }
    if (patch.parentId) {
      const cycle =
        patch.parentId === taskId ||
        (await wouldCreateParentCycle(projectId, taskId, patch.parentId));
      if (cycle) {
        return c.json({ error: 'parent_id would create a cycle', code: 'parent_cycle' }, 400);
      }
    }

    const row = await patchTask(projectId, taskId, patch);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ task: serializeAgiTask(row) });
  },
);

// ─── POST /:projectId/agi/tasks/:taskId/claim ───────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/tasks/{taskId}/claim',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/tasks/:taskId/claim',
    ...auth,
    request: {
      params: TaskParams,
      body: { content: { 'application/json': { schema: AgiTaskBodySchema } } },
    },
    responses: {
      200: json(AgiTaskClaimResultSchema, 'Claimed'),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const taskId = c.req.param('taskId');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    if (!UUID_V4_REGEX.test(taskId)) return c.json({ error: 'Not found' }, 404);

    const parsed = parseClaimBody(await readBody(c));
    if (!parsed.ok) return c.json(parsed.error, 400);
    const { sessionId, ttlSeconds, status } = parsed.value;

    // R-18: the winner is decided by this ONE statement. Nothing above it reads
    // the row, so there is no window between deciding and taking.
    const claimed = await claimTask({
      workspaceId: projectId,
      taskId,
      sessionId,
      ttlSeconds,
      status,
    });
    if (claimed) return c.json({ task: serializeAgiTask(claimed), claimed: true });

    // Zero rows means this caller LOST. The follow-up read is DIAGNOSTIC ONLY —
    // it explains the loss and never retries, because per R-18 the caller must
    // pick different work rather than wait for this one.
    const row = await loadTask(projectId, taskId);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (isTerminalTaskStatus(row.status)) {
      return c.json({ error: `Task is ${row.status}`, code: 'task_terminal' }, 409);
    }
    return c.json(
      {
        error: 'Task is claimed by another session',
        code: 'claim_conflict',
        claim: {
          session_id: row.claimSessionId,
          expires_at: row.claimExpiresAt?.toISOString() ?? null,
        },
      },
      409,
    );
  },
);

// ─── POST /:projectId/agi/tasks/:taskId/release ─────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/tasks/{taskId}/release',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/tasks/:taskId/release',
    ...auth,
    request: {
      params: TaskParams,
      body: { content: { 'application/json': { schema: AgiTaskBodySchema } } },
    },
    responses: {
      200: json(AgiTaskReleaseResultSchema, 'Released'),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const taskId = c.req.param('taskId');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    if (!UUID_V4_REGEX.test(taskId)) return c.json({ error: 'Not found' }, 404);

    const parsed = parseReleaseBody(await readBody(c));
    if (!parsed.ok) return c.json(parsed.error, 400);
    const { sessionId, status } = parsed.value;

    const released = await releaseTask({ workspaceId: projectId, taskId, sessionId, status });
    if (released) return c.json({ task: serializeAgiTask(released), released: true });

    const row = await loadTask(projectId, taskId);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ error: 'Task is not claimed by this session', code: 'claim_not_held' }, 409);
  },
);
