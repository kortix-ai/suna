/**
 * AGI human requests — the HTTP surface (spec §4.3, R-12g).
 *
 * Mounted on `agiApp` as an import side effect like every other AGI group, so
 * `/{projectId}/agi/requests` is /v1/projects/{projectId}/agi/requests.
 *
 *   POST …/tasks/{taskId}/requests   Raise one. Records it, resolves a specific
 *                                    responder, and DELIVERS it — in the same
 *                                    call, because a request that is recorded
 *                                    and not sent is the bug (R-12g).
 *   GET  …/requests                  The inbox: what is waiting, on whom.
 *   POST …/requests/{requestId}       Close one — satisfied or cancelled.
 *
 * One design decision worth stating: raising and delivering are ONE route, not
 * two. A "create" that leaves delivery to a later call is exactly the failure
 * §4.3 describes — the ask exists somewhere nobody looks. There is no way to
 * record a request through this API without also trying to send it.
 *
 * R-43: every capability is reachable from the API, so CLI and SDK get it
 * without a second implementation.
 */
import { agiApp } from '../app';
import { requireAgiProject } from '../access';
import { deliverRequest } from './delivery';
import { parseCreateRequestBody, parseResolveRequestBody } from './input';
import {
  AgiRequestBodySchema,
  AgiRequestCreateResultSchema,
  AgiRequestListSchema,
  AgiRequestResultSchema,
} from './schemas';
import {
  createRequest,
  isWorkspaceResponder,
  listRequests,
  listUndeliveredRequests,
  loadRequest,
  loadTaskTitles,
  markRequestDelivered,
  resolveDefaultResponder,
  resolveRequest,
} from './store';
import {
  REQUEST_LIST_DEFAULT_LIMIT,
  REQUEST_LIST_MAX_LIMIT,
  isRequestStatus,
  requestFingerprint,
  serializeAgiRequest,
} from './wire';
import { loadTask } from '../tasks/store';
import { parseBoundedInteger } from '../tasks/wire';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { UUID_V4_REGEX, readBody } from '../../projects/lib/serializers';
import { createRoute, z } from '@hono/zod-openapi';

const ProjectParams = z.object({ projectId: z.string() });
const TaskParams = z.object({ projectId: z.string(), taskId: z.string() });
const RequestParams = z.object({ projectId: z.string(), requestId: z.string() });

// ─── POST /:projectId/agi/tasks/:taskId/requests ────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/tasks/{taskId}/requests',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/tasks/:taskId/requests',
    ...auth,
    request: {
      params: TaskParams,
      body: { content: { 'application/json': { schema: AgiRequestBodySchema } } },
    },
    responses: {
      200: json(AgiRequestCreateResultSchema, 'Existing request (deduped on origin_fingerprint)'),
      201: json(AgiRequestCreateResultSchema, 'Raised and delivered'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const taskId = c.req.param('taskId');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    if (!UUID_V4_REGEX.test(taskId)) return c.json({ error: 'Not found' }, 404);
    const task = await loadTask(projectId, taskId);
    if (!task) return c.json({ error: 'Not found' }, 404);

    const parsed = parseCreateRequestBody((await readBody(c)) ?? {});
    if (!parsed.ok) return c.json(parsed.error, 400);
    const fields = parsed.value;

    // An explicit responder must be someone this workspace can actually address.
    // A uuid that belongs to nobody here would satisfy every CHECK constraint and
    // still be delivered to no one, while reading as a healthy live path — which
    // is the precise failure §4.3 exists to close.
    if (fields.responderUserId) {
      const addressable = await isWorkspaceResponder({
        workspaceId: projectId,
        accountId: prelude.loaded.row.accountId,
        userId: fields.responderUserId,
      });
      if (!addressable) {
        return c.json(
          { error: 'responder_user_id is not a member of this workspace', code: 'unknown_responder' },
          400,
        );
      }
    }

    // Fall back, in order: the task's own human assignee (they already own this
    // work), then the account's owner/admin — the same principal unattended work
    // runs as and the same one R-32 escalates to.
    const responderUserId =
      fields.responderUserId ??
      task.assigneeUserId ??
      (await resolveDefaultResponder(prelude.loaded.row.accountId));

    // The session is taken from the CALLER'S TOKEN when it has one, not from the
    // body, for the same reason `observe` derives its source that way: an
    // unattended run's identity is already on its token and cannot be forgotten.
    const sessionId =
      fields.requestedBySessionId ??
      (typeof c.get('sessionId') === 'string' && c.get('sessionId').length > 0
        ? c.get('sessionId')
        : null);

    const { row, created } = await createRequest({
      workspaceId: projectId,
      taskId,
      kind: fields.kind,
      need: fields.need,
      why: fields.why,
      url: fields.url,
      responderUserId,
      requestedBySessionId: sessionId,
      // Idempotency is the DEFAULT. A daily push re-deriving the same block
      // every morning must produce one row and one DM, not one of each per day.
      originFingerprint:
        fields.originFingerprint ??
        requestFingerprint({ taskId, kind: fields.kind, need: fields.need }),
    });

    // A dedupe is deliberately NOT re-delivered. The human was already told; the
    // fix for an ignored ask is the inbox getting louder, never the bot repeating
    // itself once a day forever.
    if (!created) {
      return c.json(
        { request: serializeAgiRequest(row), created: false, delivered_via: row.deliveredVia },
        200,
      );
    }

    const delivery = await deliverRequest({
      workspaceId: projectId,
      request: row,
      taskTitle: task.title,
    });
    const delivered = delivery.via
      ? await markRequestDelivered({ workspaceId: projectId, requestId: row.requestId, via: delivery.via })
      : null;

    return c.json(
      {
        request: serializeAgiRequest(delivered ?? row),
        created: true,
        delivered_via: delivery.via,
      },
      201,
    );
  },
);

// ─── GET /:projectId/agi/requests ───────────────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agi/requests',
    tags: ['agi'],
    summary: 'GET /:projectId/agi/requests',
    ...auth,
    request: {
      params: ProjectParams,
      // Free-form strings so a bad value produces this route's own `Invalid
      // <param>` envelope rather than the shared zod-failure one.
      query: z
        .object({
          task: z.string(),
          responder: z.string(),
          status: z.string(),
          undelivered: z.string(),
          limit: z.string(),
        })
        .partial(),
    },
    responses: {
      200: json(AgiRequestListSchema, 'Pending requests, oldest first'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const prelude = await requireAgiProject(c, projectId, 'read', PROJECT_ACTIONS.PROJECT_READ);
    if (!prelude.ok) return prelude.response;

    const query = c.req.query() as Record<string, string>;

    const limit = parseBoundedInteger(query.limit, {
      min: 1,
      max: REQUEST_LIST_MAX_LIMIT,
      fallback: REQUEST_LIST_DEFAULT_LIMIT,
    });
    if (limit === null) return c.json({ error: 'Invalid limit' }, 400);

    // `undelivered` is its own view rather than a filter: it means "the system
    // tried to reach a human and could not", which is a different question from
    // "what is waiting" and must be askable without knowing whom to ask about.
    if (query.undelivered !== undefined) {
      if (query.undelivered !== '1' && query.undelivered !== 'true') {
        return c.json({ error: 'Invalid undelivered' }, 400);
      }
      const rows = await listUndeliveredRequests(projectId, limit);
      const titles = await loadTaskTitles(projectId, rows.map((row) => row.taskId));
      return c.json({
        requests: rows.map((row) => ({
          ...serializeAgiRequest(row),
          task_title: titles.get(row.taskId) ?? null,
        })),
        truncated: rows.length === limit,
      });
    }

    let taskId: string | undefined;
    if (query.task !== undefined) {
      if (!UUID_V4_REGEX.test(query.task)) return c.json({ error: 'Invalid task' }, 400);
      taskId = query.task;
    }

    // `me` is the whole point of the inbox and is resolved server-side: a client
    // that had to know its own user id in order to ask "what is waiting on me?"
    // would get it wrong exactly when it matters, inside an unattended run.
    let responderUserId: string | undefined;
    if (query.responder !== undefined) {
      if (query.responder === 'me') {
        responderUserId = prelude.loaded.userId;
      } else if (UUID_V4_REGEX.test(query.responder)) {
        responderUserId = query.responder;
      } else {
        return c.json({ error: 'Invalid responder' }, 400);
      }
    }

    // Absent means `pending`: the queue is read far more often than history, the
    // same default `tasks ls` takes with `open`.
    const status = query.status ?? 'pending';
    if (status !== 'all' && !isRequestStatus(status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }

    const rows = await listRequests(projectId, { taskId, responderUserId, status, limit });
    const titles = await loadTaskTitles(projectId, rows.map((row) => row.taskId));
    return c.json({
      requests: rows.map((row) => ({
        ...serializeAgiRequest(row),
        task_title: titles.get(row.taskId) ?? null,
      })),
      truncated: rows.length === limit,
    });
  },
);

// ─── POST /:projectId/agi/requests/:requestId ───────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/requests/{requestId}',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/requests/:requestId',
    ...auth,
    request: {
      params: RequestParams,
      body: { content: { 'application/json': { schema: AgiRequestBodySchema } } },
    },
    responses: {
      200: json(AgiRequestResultSchema, 'Closed'),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const requestId = c.req.param('requestId');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    if (!UUID_V4_REGEX.test(requestId)) return c.json({ error: 'Not found' }, 404);

    const parsed = parseResolveRequestBody((await readBody(c)) ?? {});
    if (!parsed.ok) return c.json(parsed.error, 400);

    const row = await resolveRequest({
      workspaceId: projectId,
      requestId,
      status: parsed.value.status,
      userId: prelude.loaded.userId,
      note: parsed.value.note,
    });
    if (row) return c.json({ request: serializeAgiRequest(row) });

    // Zero rows means either it does not exist here or someone already closed
    // it. Only the second is a conflict, and the two must stay distinguishable —
    // a closed request answered twice is normal, a missing one is a caller bug.
    const existing = await loadRequest(projectId, requestId);
    if (!existing) return c.json({ error: 'Not found' }, 404);
    return c.json(
      { error: `Request is already ${existing.status}`, code: 'request_not_pending' },
      409,
    );
  },
);
