/**
 * AGI goals — the HTTP surface (docs/specs/2026-07-26-agi-autonomous-operations.md §4).
 *
 * Registered as an import side effect on `agiApp`, which is mounted at
 * /v1/projects, so `/{projectId}/agi/goals` is the full
 * /v1/projects/{projectId}/agi/goals. Backs `kortix goals ls|show|push` (R-42).
 *
 * Every handler opens with `requireAgiProject` — floor, leaf, then the `agi`
 * gate, in that order — so a caller who cannot reach the project can never learn
 * from the response which features it has on.
 *
 * READ-ONLY over the manifest. Goals are authored state applied by `kortix ship`
 * (R-6) and their status changes only by a human edit (R-9), so there is no
 * create, no patch, and deliberately no way to mark a goal achieved from here.
 * The one mutating route, `push`, does not touch the goal at all — it fires the
 * goal's derived trigger through the ordinary trigger subsystem (R-8).
 */
import { agiApp } from '../app';
import { requireAgiProject } from '../access';
import { listTasks } from '../tasks/store';
import { serializeAgiTask, OPEN_TASK_STATUSES, TASK_RELATION_CAP } from '../tasks/wire';
import {
  AgiGoalDetailSchema,
  AgiGoalListSchema,
  AgiGoalPushBodySchema,
  AgiGoalPushResultSchema,
} from './schemas';
import { countTasksByGoal, goalDerivedTrigger, goalTriggerRuntime, loadProjectGoals } from './store';
import {
  emptyGoalTaskCounts,
  goalIssues,
  parseGoalStatusFilter,
  serializeAgiGoal,
  serializeGoalMetricSeries,
} from './wire';
import { METRIC_WINDOW, loadMetricWindows } from '../observations/store';
import { rollupGoalMetrics, type GoalMetricSummary } from '../observations/wire';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import {
  fireGitTrigger,
  markGitTriggerFired,
  renderPromptTemplate,
  triggersPausedForProject,
} from '../../projects/lib/triggers';
import { readBody, requestAuditContext } from '../../projects/lib/serializers';
import { createRoute, z } from '@hono/zod-openapi';

const ProjectParams = z.object({ projectId: z.string() });
const GoalParams = z.object({ projectId: z.string(), slug: z.string() });

/** A push reason is recorded on the session prompt, so it is bounded like any
 *  other free text that reaches a model. */
const PUSH_REASON_MAX_LENGTH = 2000;

// ─── GET /:projectId/agi/goals ──────────────────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agi/goals',
    tags: ['agi'],
    summary: 'GET /:projectId/agi/goals',
    ...auth,
    request: {
      params: ProjectParams,
      // Free-form so a bad value produces this route's `Invalid status` envelope
      // rather than the shared zod-failure one.
      query: z.object({ status: z.string() }).partial(),
    },
    responses: {
      200: json(AgiGoalListSchema, 'Goals'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const prelude = await requireAgiProject(c, projectId, 'read', PROJECT_ACTIONS.PROJECT_READ);
    if (!prelude.ok) return prelude.response;

    const status = parseGoalStatusFilter(c.req.query('status'));
    if (!status) return c.json({ error: 'Invalid status' }, 400);

    const loaded = await loadProjectGoals(prelude.loaded.row);
    const visible =
      status === 'all' ? loaded.specs : loaded.specs.filter((goal) => goal.status === status);

    // Counts and metrics come from the FULL slug set, not the filtered one,
    // because the rollup is per-goal — filtering the query would only save a
    // WHERE clause. Two queries for the whole list, never one per goal.
    const slugs = loaded.specs.map((goal) => goal.slug);
    const [counts, windows] = await Promise.all([
      countTasksByGoal(projectId, slugs),
      loadMetricWindows(projectId, slugs),
    ]);
    const metrics = rollupGoalMetrics(windows, METRIC_WINDOW);

    return c.json({
      // Declaration order, never sorted: the author's ordering IS the priority
      // ordering they wrote the file for (R-10).
      goals: visible.map((goal) =>
        serializeAgiGoal(
          goal,
          counts.get(goal.slug) ?? emptyGoalTaskCounts(),
          metrics.get(goal.slug) ?? [],
        ),
      ),
      // A malformed goal is REPORTED, never omitted — a goal with a typo'd
      // `done_when` must not silently stop existing. The trigger list reports
      // the same errors (see `desugarGoalTriggers`); this is the surface that
      // also carries the entry's ordinal, which is all a slug-less entry has.
      errors: goalIssues(loaded),
    });
  },
);

// ─── GET /:projectId/agi/goals/:slug ────────────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/agi/goals/{slug}',
    tags: ['agi'],
    summary: 'GET /:projectId/agi/goals/:slug',
    ...auth,
    request: { params: GoalParams },
    responses: {
      200: json(AgiGoalDetailSchema, 'Goal with its open tasks and derived trigger'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const prelude = await requireAgiProject(c, projectId, 'read', PROJECT_ACTIONS.PROJECT_READ);
    if (!prelude.ok) return prelude.response;

    const loaded = await loadProjectGoals(prelude.loaded.row);
    const goal = loaded.specs.find((spec) => spec.slug === slug);
    if (!goal) return c.json({ error: 'Not found' }, 404);

    const [counts, openTasks, runtime, windows] = await Promise.all([
      countTasksByGoal(projectId, [goal.slug]),
      listTasks(projectId, {
        status: { kind: 'in', statuses: [...OPEN_TASK_STATUSES] },
        goal: { kind: 'value', value: goal.slug },
        limit: TASK_RELATION_CAP,
      }),
      goal.triggerSlug ? goalTriggerRuntime(projectId, goal.triggerSlug) : null,
      loadMetricWindows(projectId, [goal.slug]),
    ]);
    const metrics: GoalMetricSummary[] =
      rollupGoalMetrics(windows, METRIC_WINDOW).get(goal.slug) ?? [];

    // Resolved through the trigger extractor, so an authored `triggers:` entry
    // that claims the derived slug is what shows up here — the same trigger the
    // sweep would actually fire.
    const spec =
      goal.triggerSlug && loaded.manifest
        ? goalDerivedTrigger(loaded.manifest, goal.triggerSlug)
        : null;

    const now = new Date();
    return c.json({
      goal: serializeAgiGoal(goal, counts.get(goal.slug) ?? emptyGoalTaskCounts(), metrics),
      // The same metrics the goal carries, plus their points. Kept as a sibling
      // key rather than fattening `goal.metrics` so the goal object is byte-wise
      // identical in the list and the detail view.
      metric_series: serializeGoalMetricSeries(metrics),
      open_tasks: openTasks.map((row) => serializeAgiTask(row, now)),
      trigger: spec
        ? {
            slug: spec.slug,
            enabled: spec.enabled,
            cron: spec.cron,
            timezone: spec.timezone,
            session_mode: spec.sessionMode,
            agent: spec.agent,
            last_fired_at: runtime?.lastFiredAt?.toISOString() ?? null,
            last_status: runtime?.lastStatus ?? null,
            last_error: runtime?.lastError ?? null,
            last_attempt_at: runtime?.lastAttemptAt?.toISOString() ?? null,
          }
        : null,
      triggers_paused: triggersPausedForProject(prelude.loaded.row.metadata),
    });
  },
);

// ─── POST /:projectId/agi/goals/:slug/push ──────────────────────────────────

agiApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/agi/goals/{slug}/push',
    tags: ['agi'],
    summary: 'POST /:projectId/agi/goals/:slug/push',
    ...auth,
    request: {
      params: GoalParams,
      body: { content: { 'application/json': { schema: AgiGoalPushBodySchema } } },
    },
    responses: {
      202: json(AgiGoalPushResultSchema, 'Pushed'),
      ...errors(400, 401, 403, 404, 409, 500),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    // Floor 'read' + `project.trigger.fire`, exactly the gate the manual
    // `/triggers/:slug/fire` route uses: this IS a manual trigger fire, and a
    // member who may fire a trigger by slug must not be refused the same fire
    // because it was reached through its goal.
    const prelude = await requireAgiProject(
      c,
      projectId,
      'read',
      PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
    );
    if (!prelude.ok) return prelude.response;

    const body = (await readBody(c)) as Record<string, unknown> | null;
    const rawReason = body?.reason;
    if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') {
      return c.json({ error: 'reason must be a string' }, 400);
    }
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (reason.length > PUSH_REASON_MAX_LENGTH) {
      return c.json({ error: `reason must be at most ${PUSH_REASON_MAX_LENGTH} characters` }, 400);
    }

    const loaded = await loadProjectGoals(prelude.loaded.row);
    const goal = loaded.specs.find((spec) => spec.slug === slug);
    if (!goal) return c.json({ error: 'Not found' }, 404);

    // Both conflicts are 409 and neither is retryable: the caller has to edit
    // kortix.yaml, which is a human act, not a backoff.
    if (!goal.push || !goal.triggerSlug) {
      return c.json(
        { error: `Goal "${goal.slug}" declares no push`, code: 'goal_no_push' },
        409,
      );
    }
    if (goal.status !== 'active') {
      return c.json(
        { error: `Goal "${goal.slug}" is ${goal.status}, not active`, code: 'goal_not_active' },
        409,
      );
    }

    const spec = loaded.manifest ? goalDerivedTrigger(loaded.manifest, goal.triggerSlug) : null;
    if (!spec) return c.json({ error: 'Not found' }, 404);

    const now = new Date();
    const payload = {
      trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      goal: { slug: goal.slug, title: goal.title },
      fired_at: now.toISOString(),
      source: 'manual',
      actor: prelude.loaded.userId,
      reason: reason || null,
      message: { text: reason, source: 'manual_test' },
    };
    // The goal's push prompt carries no placeholders, so the reason would be
    // rendered nowhere — append it, because "why you pushed" is the context the
    // session is least able to reconstruct.
    const renderedPrompt = reason
      ? `${renderPromptTemplate(spec.promptTemplate, payload)}\n\nReason for this push: ${reason}`
      : renderPromptTemplate(spec.promptTemplate, payload);

    const result = await fireGitTrigger({
      spec,
      project: prelude.loaded.row,
      payload,
      renderedPrompt,
      source: 'manual',
      request: requestAuditContext(c),
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
    }
    await markGitTriggerFired(projectId, spec.slug, now, result.status);
    return c.json(
      {
        status: result.status === 'queued' ? 'queued' : result.deduped ? 'deduped' : 'fired',
        trigger_slug: spec.slug,
        session_id: result.sessionId ?? null,
        command_id: result.commandId ?? null,
        deduped: result.deduped ?? false,
        reason: result.reason ?? null,
      },
      202,
    );
  },
);
