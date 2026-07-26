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
  resolveWorkspaceGoalLiveness,
  resolveWorkspaceLiveness,
  serializeGoalLivenessView,
  serializeLivenessView,
  serializeSweepOutcome,
  sweepWorkspaceLiveness,
} from './surface';
import { loadProjectGoals } from '../goals/store';
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
    // Goals come from kortix.yaml, so this read costs one git round trip that
    // the task half does not. It is not optional: R-12e says a flat line MUST
    // surface here, and a stall surface that can only see tasks is exactly the
    // blind spot §4.2 was written about — the loop looks alive for three weeks
    // while the metric has not moved.
    const loaded = await loadProjectGoals(prelude.loaded.row);
    const [liveness, goals] = await Promise.all([
      resolveWorkspaceLiveness({ workspaceId: projectId, now, limit }),
      resolveWorkspaceGoalLiveness({ workspaceId: projectId, goals: loaded.specs }),
    ]);

    return c.json({
      tasks: liveness.views.map((view) => serializeLivenessView(view, now)),
      stalled: liveness.stalled.map((view) => serializeLivenessView(view, now)),
      // Unchanged meaning: TASKS that are stuck. Widening it would silently
      // change what every existing caller's number counts.
      stalled_count: liveness.stalled.length,
      truncated: liveness.truncated,
      goals: goals.views.map(serializeGoalLivenessView),
      stalled_goals: goals.stalled.map(serializeGoalLivenessView),
      stalled_goal_count: goals.stalled.length,
      // R-12d, deliberately its own count: a goal nobody has ever measured is a
      // different problem from one whose metric stopped moving, and the fix is a
      // different act. Collapsing them would lose the distinction §4.2 exists for.
      unmeasurable_goals: goals.unmeasurable.map(serializeGoalLivenessView),
      unmeasurable_goal_count: goals.unmeasurable.length,
      // The one number that means "how much is stuck" now that there are two
      // kinds of stuck. Callers that want a single health check read this.
      stalled_total: liveness.stalled.length + goals.stalled.length,
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

    // TASKS only, deliberately. A flat-line goal (R-12e) is reported by the GET
    // above and never swept: R-29 asks for a stall to be surfaced, not retried,
    // and the answer to a metric that stopped moving is a human or the next push
    // choosing a different move — not a continuation task manufactured for a goal
    // that already has a standing `push` to advance it.
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
