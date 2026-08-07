import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions } from '@kortix/db';
import { goalPushTriggerSlug } from '@kortix/manifest-schema';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { getSessionResourceUsage } from '../../shared/session-costs';
import {
  type ProjectGoalObservation,
  type ProjectTask,
  claimProjectTask,
  createProjectTask,
  recordProjectTaskProgress,
  registerProjectTaskWorker,
  settleProjectTaskNoProgress,
  getProjectTask,
  getProjectTaskWorkerBinding,
  projectTaskWorkerAdmissionState,
  listProjectGoalObservations,
  listProjectTasks,
  recordProjectGoalObservation,
  transitionProjectTask,
} from '../generated-state-store';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { withProjectGitAuth } from '../lib/git';
import { requestAuditContext } from '../lib/serializers';
import { fireGitTrigger, markGitTriggerFired, renderPromptTemplate } from '../lib/triggers';
import { drainSessionLifecycleQueue } from '../session-lifecycle/engine';
import { WorkerContractSchema } from './goals-tasks-schemas';
import {
  type GitGoalSpec,
  type LoadedGoals,
  extractGoals,
  extractTriggers,
  readManifest,
} from '../triggers';
import {
  GoalsTasksServiceError,
  MAX_TASK_LEASE_SECONDS,
  MIN_TASK_LEASE_SECONDS,
  blockTaskForProject,
  claimTaskForProject,
  completeTaskForProject,
  mapGeneratedStateError,
  resolveObservationSessionId,
} from './goals-tasks-service';

const SlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);
const ProjectParamsSchema = z.object({ projectId: z.string().uuid() }).strict();
const GoalParamsSchema = ProjectParamsSchema.extend({ slug: SlugSchema }).strict();
const TaskParamsSchema = ProjectParamsSchema.extend({ taskId: z.string().uuid() }).strict();
const TaskStatusSchema = z.enum([
  'backlog',
  'todo',
  'doing',
  'blocked',
  'review',
  'done',
  'cancelled',
]);

const GoalMetricSchema = z
  .object({
    name: z.string(),
    direction: z.enum(['increase', 'decrease']),
    target: z.number().nullable(),
    unit: z.string().nullable(),
  })
  .strict();
const GoalSchema = z
  .object({
    slug: z.string(),
    path: z.string(),
    title: z.string(),
    done_when: z.string(),
    status: z.enum(['active', 'achieved', 'paused', 'abandoned']),
    push_cron: z.string().nullable(),
    timezone: z.string(),
    agent: z.string().nullable(),
    metrics: z.array(GoalMetricSchema),
  })
  .strict()
  .openapi('ProjectGoal');
const GoalErrorSchema = z
  .object({ slug: z.string(), path: z.string(), error: z.string() })
  .strict()
  .openapi('ProjectGoalParseError');
const GoalsResponseSchema = z
  .object({ goals: z.array(GoalSchema), errors: z.array(GoalErrorSchema) })
  .strict();
const GoalResponseSchema = z.object({ goal: GoalSchema }).strict();

const ObservationSchema = z
  .object({
    observation_id: z.string().uuid(),
    project_id: z.string().uuid(),
    goal_slug: z.string(),
    metric: z.string(),
    value: z.number().finite(),
    source: z.string(),
    session_id: z.string().nullable(),
    observed_at: z.string().datetime({ offset: true }),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ProjectGoalObservation');
const ObservationResponseSchema = z.object({ observation: ObservationSchema }).strict();
const ObservationsResponseSchema = z.object({ observations: z.array(ObservationSchema) }).strict();
const ObservationBodySchema = z
  .object({
    metric: z.string().trim().min(1).max(128),
    value: z.number().finite(),
    source: z.string().trim().min(1).max(128),
    session_id: z.string().trim().min(1).max(256).optional(),
    observed_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const ObservationsQuerySchema = z
  .object({
    metric: z.string().trim().min(1).max(128),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
  })
  .strict();

const TaskSchema = z
  .object({
    task_id: z.string().uuid(),
    project_id: z.string().uuid(),
    goal_slug: z.string(),
    parent_id: z.string().uuid().nullable(),
    title: z.string(),
    body: z.string(),
    status: TaskStatusSchema,
    priority: z.number().int(),
    assignee_agent: z.string().nullable(),
    assignee_user_id: z.string().uuid().nullable(),
    blocked_by: z.array(z.string().uuid()),
    origin: z.string(),
    origin_fingerprint: z.string().nullable(),
    claim_session_id: z.string().nullable(),
    claimed_at: z.string().datetime({ offset: true }).nullable(),
    claim_expires_at: z.string().datetime({ offset: true }).nullable(),
    liveness_worker_session_id: z.string().nullable(),
    liveness_coordinator_session_id: z.string().nullable(),
    liveness_worker_contract: WorkerContractSchema.nullable(),
    liveness_started_at: z.string().datetime({ offset: true }).nullable(),
    liveness_deadline_at: z.string().datetime({ offset: true }).nullable(),
    liveness_iterations_admitted: z.number().int().nonnegative(),
    no_progress_settlements: z.number().int().min(0).max(2),
    continuation_consumed_at: z.string().datetime({ offset: true }).nullable(),
    last_progress_at: z.string().datetime({ offset: true }).nullable(),
    last_progress_ref: z.string().nullable(),
    last_no_progress_settlement_id: z.string().nullable(),
    last_no_progress_action: z.enum(['continuation_queued', 'blocked_escalation_queued']).nullable(),
    last_no_progress_command_id: z.string().uuid().nullable(),
    escalated_at: z.string().datetime({ offset: true }).nullable(),
    liveness_blocker: z.string().nullable(),
    result: z.record(z.any()),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ProjectGeneratedTask');
const TaskResponseSchema = z.object({ task: TaskSchema }).strict();
const TasksResponseSchema = z.object({ tasks: z.array(TaskSchema) }).strict();
const CreateTaskResponseSchema = z.object({ task: TaskSchema, created: z.boolean() }).strict();
const CreateTaskBodySchema = z
  .object({
    goal_slug: SlugSchema,
    parent_id: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(500),
    body: z.string().max(100_000).optional(),
    status: z.enum(['backlog', 'todo', 'doing', 'review', 'cancelled']).optional(),
    priority: z.number().int().safe().optional(),
    assignee_agent: z.string().trim().min(1).max(128).nullable().optional(),
    assignee_user_id: z.string().uuid().nullable().optional(),
    blocked_by: z.array(z.string().uuid()).max(1_000).optional(),
    origin: z.string().trim().min(1).max(128),
    origin_fingerprint: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.assignee_agent && body.assignee_user_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignee_agent'],
        message: 'assignee_agent and assignee_user_id are mutually exclusive',
      });
    }
  });
const TaskListQuerySchema = z
  .object({
    goal_slug: SlugSchema.optional(),
    status: z.union([TaskStatusSchema, z.array(TaskStatusSchema)]).optional(),
    limit: z.coerce.number().int().min(1).max(1_000).optional(),
  })
  .strict();
const ClaimTaskBodySchema = z
  .object({
    session_id: z.string().trim().min(1).max(256),
    lease_seconds: z
      .number()
      .int()
      .min(MIN_TASK_LEASE_SECONDS)
      .max(MAX_TASK_LEASE_SECONDS)
      .default(900),
  })
  .strict();
const EvidenceSchema = z
  .object({
    ref: z.string().trim().min(1).max(2_048),
  })
  .strict();
const DoneTaskBodySchema = z
  .object({
    evidence: z.array(EvidenceSchema).min(1).max(1_000),
    session_id: z.string().trim().min(1).max(256),
  })
  .strict();
const BlockTaskBodySchema = z
  .object({
    blocker: z.string().trim().min(1).max(100_000),
    session_id: z.string().trim().min(1).max(256),
  })
  .strict();

const RegisterWorkerBodySchema = z
  .object({
    session_id: z.string().trim().min(1).max(256),
    worker_session_id: z.string().trim().min(1).max(256),
    prompt: z.string().trim().min(1).max(100_000),
    contract: WorkerContractSchema,
  })
  .strict();
const ProgressBodySchema = z
  .object({
    session_id: z.string().trim().min(1).max(256),
    worker_session_id: z.string().trim().min(1).max(256),
    ref: z.string().trim().min(1).max(2_048),
  })
  .strict();
const NoProgressBodySchema = z
  .object({
    session_id: z.string().trim().min(1).max(256),
    worker_session_id: z.string().trim().min(1).max(256),
    settlement_id: z.string().trim().min(1).max(256),
    reason: z.string().trim().min(1).max(100_000),
  })
  .strict();
const MeasuredUsageSchema = z.object({
  total_cost: z.number(), input_tokens: z.number(), output_tokens: z.number(),
  cached_tokens: z.number(), cache_write_tokens: z.number(), total_tokens: z.number(),
  request_count: z.number(),
}).strict();

function serializeGoal(goal: GitGoalSpec) {
  return {
    slug: goal.slug,
    path: goal.path,
    title: goal.title,
    done_when: goal.doneWhen,
    status: goal.status,
    push_cron: goal.pushCron,
    timezone: goal.timezone,
    agent: goal.agent,
    metrics: goal.metrics.map((metric) => ({
      name: metric.name,
      direction: metric.direction,
      target: metric.target,
      unit: metric.unit,
    })),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeObservation(row: ProjectGoalObservation) {
  return {
    observation_id: row.observationId,
    project_id: row.projectId,
    goal_slug: row.goalSlug,
    metric: row.metric,
    value: row.value,
    source: row.source,
    session_id: row.sessionId,
    observed_at: iso(row.observedAt),
    created_at: iso(row.createdAt),
  };
}

function serializeTask(row: ProjectTask) {
  return {
    task_id: row.taskId,
    project_id: row.projectId,
    goal_slug: row.goalSlug,
    parent_id: row.parentId,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    assignee_agent: row.assigneeAgent,
    assignee_user_id: row.assigneeUserId,
    blocked_by: row.blockedBy,
    origin: row.origin,
    origin_fingerprint: row.originFingerprint,
    claim_session_id: row.claimSessionId,
    claimed_at: row.claimedAt ? iso(row.claimedAt) : null,
    claim_expires_at: row.claimExpiresAt ? iso(row.claimExpiresAt) : null,
    liveness_worker_session_id: row.livenessWorkerSessionId,
    liveness_coordinator_session_id: row.livenessCoordinatorSessionId,
    liveness_worker_contract: row.livenessWorkerContract,
    liveness_started_at: row.livenessStartedAt ? iso(row.livenessStartedAt) : null,
    liveness_deadline_at: row.livenessDeadlineAt ? iso(row.livenessDeadlineAt) : null,
    liveness_iterations_admitted: row.livenessIterationsAdmitted,
    no_progress_settlements: row.noProgressSettlements,
    continuation_consumed_at: row.continuationConsumedAt ? iso(row.continuationConsumedAt) : null,
    last_progress_at: row.lastProgressAt ? iso(row.lastProgressAt) : null,
    last_progress_ref: row.lastProgressRef,
    last_no_progress_settlement_id: row.lastNoProgressSettlementId,
    last_no_progress_action: row.lastNoProgressAction as 'continuation_queued' | 'blocked_escalation_queued' | null,
    last_no_progress_command_id: row.lastNoProgressCommandId,
    escalated_at: row.escalatedAt ? iso(row.escalatedAt) : null,
    liveness_blocker: row.livenessBlocker,
    result: row.result,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

async function loadGoals(row: Parameters<typeof withProjectGitAuth>[0]): Promise<LoadedGoals> {
  try {
    const manifest = await readManifest(await withProjectGitAuth(row), {
      rethrowReadErrors: true,
    });
    return manifest ? extractGoals(manifest) : { specs: [], errors: [] };
  } catch (error) {
    return {
      specs: [],
      errors: [
        {
          slug: '(manifest)',
          path: row.manifestPath || 'kortix.yaml',
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

async function sessionBelongsToProject(projectId: string, sessionId: string): Promise<boolean> {
  const [session] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)))
    .limit(1);
  return Boolean(session);
}

function serviceErrorResponse(c: Context, error: unknown) {
  if (error instanceof GoalsTasksServiceError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  const mapped = mapGeneratedStateError(error);
  if (mapped) return c.json({ error: mapped.error, code: mapped.code }, mapped.status);
  throw error;
}

async function taskWorkerControlDenial(
  c: Context,
  operation: 'control' | 'own_task',
  taskId?: string,
): Promise<{ error: string; code: 'task_worker_control_denied' } | null> {
  const sessionId = callerKortixSessionId(c);
  if (!sessionId) return null;
  const state = await projectTaskWorkerAdmissionState(db, sessionId);
  if (state === 'not_worker') return null;
  if (operation === 'own_task' && state === 'bound') {
    const binding = await getProjectTaskWorkerBinding(db, sessionId);
    if (binding && binding.taskId === taskId && binding.status === 'doing') return null;
  }
  return {
    error: state === 'spawned_unbound'
      ? 'A spawned worker must bind before task effects and cannot coordinate tasks'
      : 'A task worker can mutate only its own doing task and cannot coordinate other tasks',
    code: 'task_worker_control_denied',
  };
}

// Goals are authored declarations from the default-branch manifest. Runtime
// task and observation state never changes these responses.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/goals',
    tags: ['goals'],
    summary: 'List authored project goals',
    ...auth,
    request: { params: ProjectParamsSchema },
    responses: {
      200: json(GoalsResponseSchema, 'Authored goals and parse diagnostics'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GOAL_READ,
    );
    const goals = await loadGoals(loaded.row);
    return c.json({ goals: goals.specs.map(serializeGoal), errors: goals.errors });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/goals/{slug}',
    tags: ['goals'],
    summary: 'Get an authored project goal',
    ...auth,
    request: { params: GoalParamsSchema },
    responses: {
      200: json(GoalResponseSchema, 'Authored goal and parse diagnostics'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId, slug } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GOAL_READ,
    );
    const goals = await loadGoals(loaded.row);
    const goal = goals.specs.find((candidate) => candidate.slug === slug);
    if (!goal) return c.json({ error: 'Goal not found', errors: goals.errors }, 404);
    return c.json({ goal: serializeGoal(goal) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/goals/{slug}/push',
    tags: ['goals'],
    summary: 'Push an active goal through its synthetic trigger',
    ...auth,
    request: { params: GoalParamsSchema },
    responses: {
      202: json(
        z
          .object({
            status: z.enum(['queued', 'fired', 'deduped']),
            command_id: z.string().nullable(),
            session_id: z.string().nullable(),
            reason: z.string().nullable().optional(),
            deduped: z.boolean(),
          })
          .strict(),
        'Goal push accepted',
      ),
      ...errors(400, 403, 404, 409, 500),
    },
  }),
  async (c) => {
    const { projectId, slug } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
    );
    const workerDenial = await taskWorkerControlDenial(c, 'control');
    if (workerDenial) return c.json(workerDenial, 403);

    let manifest: Awaited<ReturnType<typeof readManifest>>;
    try {
      manifest = await readManifest(await withProjectGitAuth(loaded.row), {
        rethrowReadErrors: true,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error), code: 'manifest_read' },
        409,
      );
    }
    if (!manifest) return c.json({ error: 'Goal not found' }, 404);
    const goals = extractGoals(manifest);
    const goal = goals.specs.find((candidate) => candidate.slug === slug);
    if (!goal) return c.json({ error: 'Goal not found', errors: goals.errors }, 404);
    if (goal.status !== 'active') {
      return c.json({ error: `Goal is ${goal.status}`, code: 'goal_inactive' }, 409);
    }
    if (!goal.pushCron) {
      return c.json({ error: 'Goal has no push schedule', code: 'goal_push_unavailable' }, 409);
    }

    const triggerSlug = goalPushTriggerSlug(goal.slug);
    const triggers = extractTriggers(manifest);
    const spec = triggers.specs.find((candidate) => candidate.slug === triggerSlug);
    if (!spec || !spec.enabled) {
      return c.json(
        {
          error: 'Goal push trigger is unavailable',
          code: 'goal_push_unavailable',
          errors: triggers.errors,
        },
        409,
      );
    }

    const now = new Date();
    const payload = {
      trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      goal: { slug: goal.slug },
      fired_at: now.toISOString(),
      source: 'manual',
      actor: loaded.userId,
      message: { text: '', source: 'goal_push' },
    };
    const result = await fireGitTrigger({
      spec,
      project: loaded.row,
      payload,
      renderedPrompt: renderPromptTemplate(spec.promptTemplate, payload),
      source: 'manual',
      request: requestAuditContext(c),
    });
    if (result.status === 'failed') {
      return c.json({ error: result.error ?? 'Failed to push goal' }, 500);
    }
    await markGitTriggerFired(projectId, triggerSlug, now, result.status);
    if (result.status === 'queued') {
      return c.json(
        {
          status: 'queued' as const,
          command_id: result.commandId ?? null,
          session_id: result.sessionId ?? null,
          reason: result.reason ?? null,
          deduped: result.deduped ?? false,
        },
        202,
      );
    }
    const status: 'deduped' | 'fired' = result.deduped ? 'deduped' : 'fired';
    return c.json(
      {
        status,
        command_id: result.commandId ?? null,
        session_id: result.sessionId ?? null,
        deduped: result.deduped ?? false,
      },
      202,
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/goals/{slug}/observations',
    tags: ['goals'],
    summary: 'Record a project goal metric observation',
    ...auth,
    request: {
      params: GoalParamsSchema,
      body: { content: { 'application/json': { schema: ObservationBodySchema } } },
    },
    responses: {
      201: json(ObservationResponseSchema, 'Recorded observation'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, slug } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GOAL_WRITE,
    );
    const workerDenial = await taskWorkerControlDenial(c, 'control');
    if (workerDenial) return c.json(workerDenial, 403);

    let sessionId: string | null;
    try {
      sessionId = await resolveObservationSessionId(
        { sessionBelongsToProject },
        {
          projectId,
          requestedSessionId: body.session_id,
          authenticatedSessionId: callerKortixSessionId(c),
        },
      );
    } catch (error) {
      return serviceErrorResponse(c, error);
    }
    const goals = await loadGoals(loaded.row);
    const goal = goals.specs.find((candidate) => candidate.slug === slug);
    if (!goal) return c.json({ error: 'Goal not found', errors: goals.errors }, 404);
    if (!goal.metrics.some((metric) => metric.name === body.metric)) {
      return c.json(
        { error: 'Metric is not declared by this goal', code: 'metric_not_declared' },
        400,
      );
    }
    const observation = await recordProjectGoalObservation(db, {
      projectId,
      goalSlug: slug,
      metric: body.metric,
      value: body.value,
      source: body.source,
      sessionId,
      observedAt: body.observed_at ? new Date(body.observed_at) : new Date(),
    });
    return c.json({ observation: serializeObservation(observation) }, 201);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/goals/{slug}/observations',
    tags: ['goals'],
    summary: 'List project goal metric observations',
    ...auth,
    request: { params: GoalParamsSchema, query: ObservationsQuerySchema },
    responses: {
      200: json(ObservationsResponseSchema, 'Goal metric observations'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId, slug } = c.req.valid('param');
    const query = c.req.valid('query');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GOAL_READ,
    );
    const goals = await loadGoals(loaded.row);
    const goal = goals.specs.find((candidate) => candidate.slug === slug);
    if (!goal) return c.json({ error: 'Goal not found', errors: goals.errors }, 404);
    if (!goal.metrics.some((metric) => metric.name === query.metric)) {
      return c.json(
        { error: 'Metric is not declared by this goal', code: 'metric_not_declared' },
        400,
      );
    }
    const now = new Date();
    const to = query.to ? new Date(query.to) : now;
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1_000);
    if (from > to) return c.json({ error: 'from must be before or equal to to' }, 400);
    const observations = await listProjectGoalObservations(db, {
      projectId,
      goalSlug: slug,
      metric: query.metric,
      from,
      to,
      limit: query.limit,
    });
    return c.json({ observations: observations.map(serializeObservation) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/tasks',
    tags: ['tasks'],
    summary: 'List generated project tasks',
    ...auth,
    request: { params: ProjectParamsSchema, query: TaskListQuerySchema },
    responses: {
      200: json(TasksResponseSchema, 'Project tasks'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const query = c.req.valid('query');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_READ,
    );
    const statuses = query.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : undefined;
    const tasks = await listProjectTasks(db, {
      projectId,
      goalSlug: query.goal_slug,
      statuses,
      limit: query.limit,
    });
    return c.json({ tasks: tasks.map(serializeTask) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks',
    tags: ['tasks'],
    summary: 'Create a generated project task',
    ...auth,
    request: {
      params: ProjectParamsSchema,
      body: { content: { 'application/json': { schema: CreateTaskBodySchema } } },
    },
    responses: {
      201: json(CreateTaskResponseSchema, 'Created project task'),
      200: json(CreateTaskResponseSchema, 'Existing idempotent project task'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    const workerDenial = await taskWorkerControlDenial(c, 'control');
    if (workerDenial) return c.json(workerDenial, 403);
    const goals = await loadGoals(loaded.row);
    if (!goals.specs.some((goal) => goal.slug === body.goal_slug)) {
      return c.json({ error: 'Goal not found', errors: goals.errors }, 404);
    }
    const result = await createProjectTask(db, {
      projectId,
      goalSlug: body.goal_slug,
      parentId: body.parent_id,
      title: body.title,
      body: body.body,
      status: body.status,
      priority: body.priority,
      assigneeAgent: body.assignee_agent,
      assigneeUserId: body.assignee_user_id,
      blockedBy: body.blocked_by,
      origin: body.origin,
      originFingerprint: body.origin_fingerprint,
    });
    return c.json(
      { task: serializeTask(result.task), created: result.created },
      result.created ? 201 : 200,
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/tasks/{taskId}',
    tags: ['tasks'],
    summary: 'Get a generated project task',
    ...auth,
    request: { params: TaskParamsSchema },
    responses: {
      200: json(TaskResponseSchema, 'Project task'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_READ,
    );
    const task = await getProjectTask(db, { projectId, taskId });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ task: serializeTask(task) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/claim',
    tags: ['tasks'],
    summary: 'Claim a generated project task',
    ...auth,
    request: {
      params: TaskParamsSchema,
      body: { content: { 'application/json': { schema: ClaimTaskBodySchema } } },
    },
    responses: {
      200: json(TaskResponseSchema, 'Claimed project task'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    const workerDenial = await taskWorkerControlDenial(c, 'control');
    if (workerDenial) return c.json(workerDenial, 403);
    try {
      const task = await claimTaskForProject(
        {
          sessionBelongsToProject,
          claimTask: (input) => claimProjectTask(db, input),
        },
        {
          projectId,
          taskId,
          sessionId: body.session_id,
          authenticatedSessionId: callerKortixSessionId(c),
          leaseSeconds: body.lease_seconds,
          now: new Date(),
        },
      );
      return c.json({ task: serializeTask(task) });
    } catch (error) {
      return serviceErrorResponse(c, error);
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/done',
    tags: ['tasks'],
    summary: 'Complete a generated project task with cited evidence',
    ...auth,
    request: {
      params: TaskParamsSchema,
      body: { content: { 'application/json': { schema: DoneTaskBodySchema } } },
    },
    responses: {
      200: json(TaskResponseSchema, 'Completed project task'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    const workerDenial = await taskWorkerControlDenial(c, 'own_task', taskId);
    if (workerDenial) return c.json(workerDenial, 403);
    try {
      const task = await completeTaskForProject(
        {
          sessionBelongsToProject,
          loadTaskEvidence: (input) => getProjectTask(db, input),
          transitionTask: (input) => transitionProjectTask(db, input),
        },
        {
          projectId,
          taskId,
          evidence: body.evidence,
          sessionId: body.session_id,
          authenticatedSessionId: callerKortixSessionId(c),
          now: new Date(),
        },
      );
      return c.json({ task: serializeTask(task) });
    } catch (error) {
      return serviceErrorResponse(c, error);
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/block',
    tags: ['tasks'],
    summary: 'Block a generated project task with a reason',
    ...auth,
    request: {
      params: TaskParamsSchema,
      body: { content: { 'application/json': { schema: BlockTaskBodySchema } } },
    },
    responses: {
      200: json(TaskResponseSchema, 'Blocked project task'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    const workerDenial = await taskWorkerControlDenial(c, 'own_task', taskId);
    if (workerDenial) return c.json(workerDenial, 403);
    try {
      const task = await blockTaskForProject(
        {
          sessionBelongsToProject,
          transitionTask: (input) => transitionProjectTask(db, input),
        },
        {
          projectId,
          taskId,
          blocker: body.blocker,
          sessionId: body.session_id,
          authenticatedSessionId: callerKortixSessionId(c),
          now: new Date(),
        },
      );
      return c.json({ task: serializeTask(task) });
    } catch (error) {
      return serviceErrorResponse(c, error);
    }
  },
);


projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/worker',
    tags: ['tasks'],
    summary: 'Bind one bounded worker and durably queue its initial prompt',
    ...auth,
    request: {
      params: TaskParamsSchema,
      body: { content: { 'application/json': { schema: RegisterWorkerBodySchema } } },
    },
    responses: {
      202: json(z.object({
        task: TaskSchema,
        worker: z.object({
          session_id: z.string(), command_id: z.string().uuid(), state: z.enum(['queued', 'drained']),
        }).strict(),
        contract: WorkerContractSchema,
      }).strict(), 'Worker binding and durable initial prompt'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TASK_WRITE);
    const workerDenial = await taskWorkerControlDenial(c, 'control');
    if (workerDenial) return c.json(workerDenial, 403);
    const authenticatedSessionId = callerKortixSessionId(c);
    if (authenticatedSessionId && authenticatedSessionId !== body.session_id) {
      return c.json({ error: 'A project session can register workers only for its own claim', code: 'session_identity_mismatch' }, 403);
    }
    if (!(await sessionBelongsToProject(projectId, body.session_id)) ||
        !(await sessionBelongsToProject(projectId, body.worker_session_id))) {
      return c.json({ error: 'Both sessions must belong to this project', code: 'session_not_in_project' }, 400);
    }
    try {
      const result = await registerProjectTaskWorker(db, {
        projectId,
        accountId: loaded.row.accountId,
        taskId,
        claimSessionId: body.session_id,
        workerSessionId: body.worker_session_id,
        actorUserId: loaded.userId,
        prompt: body.prompt,
        contract: body.contract,
        now: new Date(),
      });
      let state: 'queued' | 'drained' = 'queued';
      try {
        // Registration committed both rows. Drain the runtime allocation first;
        // only then may the prompt command begin its readiness wait.
        await drainSessionLifecycleQueue({
          idempotencyKey: `task-worker-provision:${taskId}:${body.worker_session_id}`,
          limit: 1,
        });
        const drained = await drainSessionLifecycleQueue({
          idempotencyKey: `task-worker:${taskId}:${body.worker_session_id}`,
          limit: 1,
        });
        if (drained.succeeded > 0) state = 'drained';
      } catch (error) {
        console.warn('[task-liveness] immediate worker provisioning/prompt drain failed; outbox will retry', {
          projectId, taskId, commandId: result.commandId,
          provisionCommandId: result.provisionCommandId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return c.json({
        task: serializeTask(result.task),
        worker: { session_id: body.worker_session_id, command_id: result.commandId, state },
        contract: body.contract,
      }, 202);
    } catch (error) {
      return serviceErrorResponse(c, error);
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/progress',
    tags: ['tasks'],
    summary: 'Record authenticated semantic worker progress',
    ...auth,
    request: { params: TaskParamsSchema, body: { content: { 'application/json': { schema: ProgressBodySchema } } } },
    responses: {
      200: json(z.object({ task: TaskSchema, action: z.literal('recorded') }).strict(), 'Progress recorded'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TASK_WRITE);
    const workerDenial = await taskWorkerControlDenial(c, 'control');
    if (workerDenial) return c.json(workerDenial, 403);
    const authenticatedSessionId = callerKortixSessionId(c);
    if (authenticatedSessionId && authenticatedSessionId !== body.session_id) {
      return c.json({ error: 'A project session can record progress only for its own claim', code: 'session_identity_mismatch' }, 403);
    }
    try {
      const task = await recordProjectTaskProgress(db, {
        projectId, taskId, claimSessionId: body.session_id,
        workerSessionId: body.worker_session_id, ref: body.ref, now: new Date(),
      });
      return c.json({ task: serializeTask(task), action: 'recorded' as const });
    } catch (error) {
      return serviceErrorResponse(c, error);
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/no-progress',
    tags: ['tasks'],
    summary: 'Atomically continue once, then block and escalate',
    ...auth,
    request: { params: TaskParamsSchema, body: { content: { 'application/json': { schema: NoProgressBodySchema } } } },
    responses: {
      200: json(z.object({
        task: TaskSchema,
        action: z.enum(['continuation_queued', 'blocked_escalation_queued']),
        command_id: z.string().uuid(),
        measured_usage: MeasuredUsageSchema,
      }).strict(), 'Durable liveness decision'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TASK_WRITE);
    const workerDenial = await taskWorkerControlDenial(c, 'control');
    if (workerDenial) return c.json(workerDenial, 403);
    const authenticatedSessionId = callerKortixSessionId(c);
    if (authenticatedSessionId && authenticatedSessionId !== body.session_id) {
      return c.json({ error: 'A project session can settle only its own claim', code: 'session_identity_mismatch' }, 403);
    }
    try {
      const measuredUsage = await getSessionResourceUsage({
        accountId: loaded.row.accountId,
        sessionId: body.worker_session_id,
      });
      const result = await settleProjectTaskNoProgress(db, {
        projectId, accountId: loaded.row.accountId, taskId,
        claimSessionId: body.session_id, workerSessionId: body.worker_session_id,
        actorUserId: loaded.userId, settlementId: body.settlement_id,
        reason: body.reason, measuredUsage, now: new Date(),
      });
      return c.json({
        task: serializeTask(result.task), action: result.action,
        command_id: result.commandId, measured_usage: result.measuredUsage,
      });
    } catch (error) {
      return serviceErrorResponse(c, error);
    }
  },
);
