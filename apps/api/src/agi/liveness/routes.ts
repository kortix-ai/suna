/**
 * AGI liveness — the HTTP surface (spec §8).
 *
 * Two routes, mounted on `agiApp` as an import side effect exactly like the task
 * routes, so `/{projectId}/agi/liveness` is
 * /v1/projects/{projectId}/agi/liveness.
 *
 *   GET  …/agi/liveness        answers "what is stuck and why" (R-29). Read-only,
 *                              derived on every call, safe to poll from a UI.
 *   POST …/agi/liveness/sweep  applies bounded recovery to whatever that read
 *                              found (R-32). Explicit and idempotent — the ONE
 *                              wake mechanism stays the trigger subsystem (R-21);
 *                              this is a body of work a session or a human runs,
 *                              not a background loop.
 *
 * R-43: every capability here is reachable from the API, so CLI and SDK get it
 * without a second implementation.
 */
import { agiApp } from '../app';
import { requireAgiProject } from '../access';
import { AgiLivenessSchema, AgiLivenessSweepSchema } from './schemas';
import {
  LIVENESS_TASK_CAP,
  resolveWorkspaceLiveness,
  serializeLivenessView,
  serializeSweepOutcome,
  sweepWorkspaceLiveness,
} from './surface';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { parseBoundedInteger } from '../tasks/wire';
import { createRoute, z } from '@hono/zod-openapi';

const ProjectParams = z.object({ projectId: z.string() });

agiApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agi/liveness',
    tags: ['agi'],
    summary: 'GET /:projectId/agi/liveness',
    ...auth,
    request: {
      params: ProjectParams,
      query: z.object({ limit: z.string() }).partial(),
    },
    responses: {
      200: json(AgiLivenessSchema, 'Open tasks with their liveness verdict'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const prelude = await requireAgiProject(c, projectId, 'read', PROJECT_ACTIONS.PROJECT_READ);
    if (!prelude.ok) return prelude.response;

    const limit = parseBoundedInteger(c.req.query('limit'), {
      min: 1,
      max: LIVENESS_TASK_CAP,
      fallback: LIVENESS_TASK_CAP,
    });
    if (limit === null) return c.json({ error: 'Invalid limit' }, 400);

    const now = new Date();
    const liveness = await resolveWorkspaceLiveness({ workspaceId: projectId, now, limit });
    return c.json({
      tasks: liveness.views.map((view) => serializeLivenessView(view, now)),
      stalled: liveness.stalled.map((view) => serializeLivenessView(view, now)),
      stalled_count: liveness.stalled.length,
      truncated: liveness.truncated,
    });
  },
);

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/liveness/sweep',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/liveness/sweep',
    ...auth,
    request: { params: ProjectParams },
    responses: {
      200: json(AgiLivenessSweepSchema, 'Recovery applied to every stalled task'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    const result = await sweepWorkspaceLiveness({
      workspaceId: projectId,
      accountId: prelude.loaded.row.accountId,
    });
    return c.json({
      scanned: result.scanned,
      stalled: result.stalled,
      outcomes: result.outcomes.map(serializeSweepOutcome),
    });
  },
);
