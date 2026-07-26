/**
 * AGI observations — the HTTP surface (spec §4.2).
 *
 * Two routes, mounted on `agiApp` as an import side effect like every other AGI
 * group, so `/{projectId}/agi/goals/{slug}/observations` is the full
 * /v1/projects/{projectId}/agi/goals/{slug}/observations.
 *
 *   POST …/observations   R-12c. THE verb. One path shared by every producer:
 *                         a cron trigger's session, a webhook handler's session,
 *                         a human at a terminal. `kortix goals observe` is this
 *                         route and nothing else.
 *   GET  …/observations   R-12b's "queried by range" — the raw series.
 *
 * They live beside the goal routes rather than inside them because the goal
 * routes are READ-ONLY over the manifest and must stay that way; this is the one
 * place in the goal surface that writes, and it writes to the database.
 *
 * R-12f is enforced structurally rather than by a check: nothing in this module,
 * or in the store it calls, can reach goal status. Status is authored state in
 * kortix.yaml (R-9) and there is no code path from here to a manifest write.
 *
 * R-12a is why there is no third route. A measurement is produced by an ordinary
 * trigger or webhook session that then calls this; there is no probe to declare,
 * no schedule to register, and no poller to configure.
 */
import { agiApp } from '../app';
import { requireAgiProject } from '../access';
import { loadProjectGoals } from '../goals/store';
import { parseObserveBody, parseObservationRangeQuery } from './input';
import { AgiObservationListSchema, AgiObserveBodySchema, AgiObserveResultSchema } from './schemas';
import {
  OBSERVATION_LIST_DEFAULT_LIMIT,
  OBSERVATION_LIST_MAX_LIMIT,
  listObservations,
  recordObservation,
} from './store';
import { serializeAgiObservation } from './wire';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { readBody } from '../../projects/lib/serializers';
import { parseBoundedInteger } from '../tasks/wire';
import { createRoute, z } from '@hono/zod-openapi';

const GoalParams = z.object({ projectId: z.string(), slug: z.string() });

/**
 * Who took the reading, when the producer did not say.
 *
 * The session id on the caller's own token is the right default and the reason
 * `--source` can be omitted: R-12a makes a trigger session the ordinary producer,
 * and that session's token already carries its identity, so the attribution
 * cannot be spoofed by forgetting the flag. A user-scoped PAT has no session, and
 * falls back to the human — still an answer, never an unattributed number.
 */
function defaultSource(c: any, userId: string): string {
  const sessionId = c.get('sessionId');
  return typeof sessionId === 'string' && sessionId.length > 0
    ? `session:${sessionId}`
    : `user:${userId}`;
}

// ─── POST /:projectId/agi/goals/:slug/observations ──────────────────────────

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/goals/{slug}/observations',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/goals/:slug/observations',
    ...auth,
    request: {
      params: GoalParams,
      body: { content: { 'application/json': { schema: AgiObserveBodySchema } } },
    },
    responses: {
      201: json(AgiObserveResultSchema, 'Recorded'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const prelude = await requireAgiProject(c, projectId, 'write', PROJECT_ACTIONS.PROJECT_WRITE);
    if (!prelude.ok) return prelude.response;

    const parsed = parseObserveBody((await readBody(c)) ?? {});
    if (!parsed.ok) return c.json(parsed.error, 400);

    // R-12c: the goal slug must exist in the manifest. Without this a typo'd slug
    // writes a series nothing will ever read — the goal would still surface as
    // unmeasurable while the numbers piled up somewhere nobody looks.
    const loaded = await loadProjectGoals(prelude.loaded.row);
    const goal = loaded.specs.find((spec) => spec.slug === slug);
    if (!goal) return c.json({ error: 'Not found' }, 404);

    // Status is deliberately NOT checked. A paused or achieved goal still accrues
    // evidence — that is exactly how you learn a goal marked achieved has since
    // regressed, and R-12f says the reading may never move the status either way.
    const observation = await recordObservation({
      workspaceId: projectId,
      goalSlug: goal.slug,
      metric: parsed.value.metric,
      value: parsed.value.value,
      source: parsed.value.source ?? defaultSource(c, prelude.loaded.userId),
      observedAt: parsed.value.observedAt,
    });

    return c.json({ observation: serializeAgiObservation(observation) }, 201);
  },
);

// ─── GET /:projectId/agi/goals/:slug/observations ───────────────────────────

agiApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agi/goals/{slug}/observations',
    tags: ['agi'],
    summary: 'GET /:projectId/agi/goals/:slug/observations',
    ...auth,
    request: {
      params: GoalParams,
      // Free-form so a bad value produces this route's own error envelope rather
      // than the shared zod-failure one.
      query: z
        .object({ metric: z.string(), since: z.string(), until: z.string(), limit: z.string() })
        .partial(),
    },
    responses: {
      200: json(AgiObservationListSchema, 'The series, newest first'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const prelude = await requireAgiProject(c, projectId, 'read', PROJECT_ACTIONS.PROJECT_READ);
    if (!prelude.ok) return prelude.response;

    const range = parseObservationRangeQuery({
      metric: c.req.query('metric'),
      since: c.req.query('since'),
      until: c.req.query('until'),
    });
    if (!range.ok) return c.json(range.error, 400);

    const limit = parseBoundedInteger(c.req.query('limit'), {
      min: 1,
      max: OBSERVATION_LIST_MAX_LIMIT,
      fallback: OBSERVATION_LIST_DEFAULT_LIMIT,
    });
    if (limit === null) return c.json({ error: 'Invalid limit' }, 400);

    // Same manifest check as the write: a series for a goal that no longer exists
    // is history nobody asked for, and answering 200 with it would let a typo
    // look like a real read.
    const loaded = await loadProjectGoals(prelude.loaded.row);
    if (!loaded.specs.some((spec) => spec.slug === slug)) {
      return c.json({ error: 'Not found' }, 404);
    }

    const rows = await listObservations(projectId, slug, { ...range.value, limit });
    return c.json({
      observations: rows.map(serializeAgiObservation),
      truncated: rows.length === limit,
    });
  },
);
