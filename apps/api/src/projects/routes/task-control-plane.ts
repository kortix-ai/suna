import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, projectTasks } from '@kortix/db/schema';
import { and, eq } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import {
  TaskCompletionGateError,
  TaskTransitionConflictError,
  getProjectTask,
  requestProjectTaskCompletion,
  transitionProjectTask,
} from '../generated-state-store';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import {
  TaskControlPlaneConflictError,
  acknowledgeProjectTaskMessage,
  addProjectTaskEvidence,
  cancelProjectTask,
  createProjectTaskBlocker,
  currentProjectTaskForSession,
  listProjectTaskBlockers,
  listProjectTaskEvents,
  listProjectTaskEvidence,
  listProjectTaskMessages,
  listProjectTaskRefinements,
  listProjectTaskSessionLinks,
  proposeProjectTaskRefinement,
  resolveProjectTaskBlocker,
  reviseProjectTaskContract,
  rollbackProjectTaskRefinement,
  sendProjectTaskMessage,
} from '../task-control-plane-store';
import { TaskSchema, serializeTask } from './goals-tasks';

const ProjectParams = z.object({ projectId: z.string().uuid() }).strict();
const TaskParams = ProjectParams.extend({ taskId: z.string().uuid() }).strict();
const BlockerParams = TaskParams.extend({
  blockerId: z.string().uuid(),
}).strict();
const MessageParams = TaskParams.extend({
  messageId: z.string().uuid(),
}).strict();
const RefinementParams = ProjectParams.extend({
  proposalId: z.string().uuid(),
}).strict();
const Requirement = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
    kind: z.enum(['command', 'http', 'artifact', 'deployment', 'policy', 'human', 'monitor']),
    description: z.string().trim().min(1).max(2_000),
    required: z.boolean().default(true),
  })
  .strict();
const ReviewPolicy = z.object({ mode: z.enum(['auto', 'human']) }).strict();

const EvidenceSchema = z
  .object({
    evidence_id: z.string().uuid(),
    project_id: z.string().uuid(),
    task_id: z.string().uuid(),
    session_id: z.string().nullable(),
    contract_revision: z.number().int().positive(),
    requirement_id: z.string().nullable(),
    kind: z.string(),
    ref: z.string(),
    summary: z.string(),
    candidate_digest: z.string(),
    state: z.enum(['passed', 'failed', 'info']),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
const BlockerSchema = z
  .object({
    blocker_id: z.string().uuid(),
    project_id: z.string().uuid(),
    task_id: z.string().uuid(),
    category: z.string(),
    requested_action: z.string(),
    target: z.record(z.any()),
    request_digest: z.string(),
    attempts_made: z.array(z.string()),
    status: z.enum(['open', 'resolved', 'canceled', 'expired']),
    next_reminder_at: z.string().datetime({ offset: true }).nullable(),
    expires_at: z.string().datetime({ offset: true }).nullable(),
    resolved_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
const EventSchema = z
  .object({
    event_id: z.string().uuid(),
    event_type: z.string(),
    actor_type: z.string(),
    actor_id: z.string().nullable(),
    session_id: z.string().nullable(),
    payload: z.record(z.any()),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
const SessionLinkSchema = z
  .object({
    task_id: z.string().uuid(),
    session_id: z.string(),
    role: z.enum(['coordinator', 'worker', 'verifier']),
    parent_session_id: z.string().nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
const MessageSchema = z
  .object({
    message_id: z.string().uuid(),
    task_id: z.string().uuid(),
    sender_session_id: z.string().nullable(),
    recipient_session_id: z.string().nullable(),
    type: z.string(),
    body: z.record(z.any()),
    correlation_id: z.string().nullable(),
    idempotency_key: z.string(),
    status: z.enum(['accepted', 'queued', 'delivered', 'processed', 'failed', 'expired']),
    acknowledged_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
const RefinementSchema = z
  .object({
    proposal_id: z.string().uuid(),
    task_id: z.string().uuid().nullable(),
    scope: z.enum(['task', 'agent', 'project', 'account', 'platform']),
    observation: z.string(),
    base_revision: z.string(),
    patch: z.record(z.any()),
    rollback_patch: z.record(z.any()),
    evidence_refs: z.array(z.string()),
    status: z.enum(['proposed', 'applied', 'rejected', 'rolled_back']),
    created_by_session_id: z.string().nullable(),
    applied_at: z.string().datetime({ offset: true }).nullable(),
    rolled_back_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

const evidenceJson = (row: Awaited<ReturnType<typeof listProjectTaskEvidence>>[number]) => ({
  evidence_id: row.evidenceId,
  project_id: row.projectId,
  task_id: row.taskId,
  session_id: row.sessionId,
  contract_revision: row.contractRevision,
  requirement_id: row.requirementId,
  kind: row.kind,
  ref: row.ref,
  summary: row.summary,
  candidate_digest: row.candidateDigest,
  state: row.state as 'passed' | 'failed' | 'info',
  created_at: row.createdAt.toISOString(),
});
const blockerJson = (row: Awaited<ReturnType<typeof listProjectTaskBlockers>>[number]) => ({
  blocker_id: row.blockerId,
  project_id: row.projectId,
  task_id: row.taskId,
  category: row.category,
  requested_action: row.requestedAction,
  target: row.target,
  request_digest: row.requestDigest,
  attempts_made: row.attemptsMade,
  status: row.status as 'open' | 'resolved' | 'canceled' | 'expired',
  next_reminder_at: row.nextReminderAt?.toISOString() ?? null,
  expires_at: row.expiresAt?.toISOString() ?? null,
  resolved_at: row.resolvedAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});
const eventJson = (row: Awaited<ReturnType<typeof listProjectTaskEvents>>[number]) => ({
  event_id: row.eventId,
  event_type: row.eventType,
  actor_type: row.actorType,
  actor_id: row.actorId,
  session_id: row.sessionId,
  payload: row.payload,
  created_at: row.createdAt.toISOString(),
});
const linkJson = (row: Awaited<ReturnType<typeof listProjectTaskSessionLinks>>[number]) => ({
  task_id: row.taskId,
  session_id: row.sessionId,
  role: row.role as 'coordinator' | 'worker' | 'verifier',
  parent_session_id: row.parentSessionId,
  created_at: row.createdAt.toISOString(),
});
const messageJson = (row: Awaited<ReturnType<typeof listProjectTaskMessages>>[number]) => ({
  message_id: row.messageId,
  task_id: row.taskId,
  sender_session_id: row.senderSessionId,
  recipient_session_id: row.recipientSessionId,
  type: row.messageType,
  body: row.body,
  correlation_id: row.correlationId,
  idempotency_key: row.idempotencyKey,
  status: row.status as 'accepted' | 'queued' | 'delivered' | 'processed' | 'failed' | 'expired',
  acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});
const refinementJson = (row: Awaited<ReturnType<typeof listProjectTaskRefinements>>[number]) => ({
  proposal_id: row.proposalId,
  task_id: row.taskId,
  scope: row.scope as 'task' | 'agent' | 'project' | 'account' | 'platform',
  observation: row.observation,
  base_revision: row.baseRevision,
  patch: row.patch,
  rollback_patch: row.rollbackPatch,
  evidence_refs: row.evidenceRefs,
  status: row.status as 'proposed' | 'applied' | 'rejected' | 'rolled_back',
  created_by_session_id: row.createdBySessionId,
  applied_at: row.appliedAt?.toISOString() ?? null,
  rolled_back_at: row.rolledBackAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

async function projectSessionExists(projectId: string, sessionId: string) {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)))
    .limit(1);
  return Boolean(row);
}

export function isHumanTaskControlPrincipal(input: {
  sessionId: string | null;
  authType: string | undefined;
}): boolean {
  return input.sessionId === null && (input.authType === 'supabase' || input.authType === 'pat');
}

export function sessionMatchesTaskLineage(
  current: { taskId: string } | null,
  targetTaskId: string,
): boolean {
  return current?.taskId === targetTaskId;
}

export function completionError(error: unknown) {
  if (error instanceof TaskCompletionGateError) {
    return {
      status: 409 as const,
      body: {
        error: error.message,
        code: error.code.toLowerCase(),
        unmet: error.unmet,
      },
    };
  }
  if (error instanceof TaskControlPlaneConflictError) {
    return {
      status: 409 as const,
      body: { error: error.message, code: error.code.toLowerCase() },
    };
  }
  if (error instanceof TaskTransitionConflictError) {
    return {
      status: 409 as const,
      body: { error: error.message, code: error.code.toLowerCase() },
    };
  }
  return null;
}

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/tasks/{taskId}/contract',
    tags: ['tasks'],
    summary: 'Create a human-authored task contract revision',
    ...auth,
    request: {
      params: TaskParams,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                intent: z.string().trim().min(1).max(100_000).optional(),
                constraints: z.array(z.string().trim().min(1)).max(100).optional(),
                out_of_scope: z.array(z.string().trim().min(1)).max(100).optional(),
                verification_requirements: z.array(Requirement).max(100).optional(),
                review_policy: ReviewPolicy.optional(),
              })
              .strict()
              .refine(
                (body) => Object.keys(body).length > 0,
                'At least one contract field is required',
              ),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ task: TaskSchema }), 'Revised task'),
      ...errors(400, 403, 404, 409),
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
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    if (
      !isHumanTaskControlPrincipal({
        sessionId: callerKortixSessionId(c),
        authType: c.get('authType'),
      })
    )
      return c.json(
        {
          error: 'Agents may propose but not apply contract revisions',
          code: 'human_required',
        },
        403,
      );
    try {
      const body = c.req.valid('json');
      const task = await reviseProjectTaskContract(db, {
        projectId,
        taskId,
        intent: body.intent,
        constraints: body.constraints,
        outOfScope: body.out_of_scope,
        verificationRequirements: body.verification_requirements,
        reviewPolicy: body.review_policy,
        actorId: loaded.userId,
        now: new Date(),
      });
      if (!task) return c.json({ error: 'Task not found' }, 404);
      return c.json({ task: serializeTask(task) });
    } catch (error) {
      const mapped = completionError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/tasks/{taskId}/evidence',
    tags: ['tasks'],
    summary: 'List immutable task evidence',
    ...auth,
    request: { params: TaskParams },
    responses: {
      200: json(z.object({ evidence: z.array(EvidenceSchema) }), 'Task evidence'),
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
    if (!(await getProjectTask(db, { projectId, taskId })))
      return c.json({ error: 'Task not found' }, 404);
    return c.json({
      evidence: (await listProjectTaskEvidence(db, { projectId, taskId })).map(evidenceJson),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/evidence',
    tags: ['tasks'],
    summary: 'Add immutable task evidence',
    ...auth,
    request: {
      params: TaskParams,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                requirement_id: z.string().trim().min(1).max(128).nullable().optional(),
                kind: z.string().trim().min(1).max(32),
                ref: z.string().trim().min(1).max(2_048),
                summary: z.string().max(10_000).optional(),
                candidate_digest: z.string().trim().min(1).max(256),
                state: z.enum(['passed', 'failed', 'info']),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      201: json(z.object({ evidence: EvidenceSchema }), 'Task evidence'),
      ...errors(400, 403, 404),
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
    const sessionId = callerKortixSessionId(c);
    if (sessionId) {
      const current = await currentProjectTaskForSession(db, {
        projectId,
        sessionId,
      });
      if (current?.taskId !== taskId)
        return c.json({ error: 'Session is outside this task lineage' }, 403);
    }
    const evidence = await addProjectTaskEvidence(db, {
      projectId,
      taskId,
      sessionId,
      requirementId: body.requirement_id ?? null,
      kind: body.kind,
      ref: body.ref,
      summary: body.summary,
      candidateDigest: body.candidate_digest,
      state: body.state,
      now: new Date(),
    });
    if (!evidence) return c.json({ error: 'Task not found' }, 404);
    return c.json({ evidence: evidenceJson(evidence) }, 201);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/request-completion',
    tags: ['tasks'],
    summary: 'Request server-gated task completion',
    ...auth,
    request: {
      params: TaskParams,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                candidate_digest: z.string().trim().min(1).max(256),
                session_id: z.string().trim().min(1).max(256).optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ task: TaskSchema }), 'Completed task'),
      409: json(
        z.object({
          error: z.string(),
          code: z.string(),
          unmet: z.array(z.any()).optional(),
        }),
        'Completion conditions unmet',
      ),
      ...errors(400, 403, 404),
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
    const principalSession = callerKortixSessionId(c);
    const sessionId = principalSession ?? body.session_id;
    if (!sessionId) return c.json({ error: 'session_id is required for a human caller' }, 400);
    if (principalSession && body.session_id && body.session_id !== principalSession)
      return c.json({ error: 'Session identity mismatch' }, 403);
    if (!(await projectSessionExists(projectId, sessionId)))
      return c.json({ error: 'Session does not belong to project' }, 400);
    try {
      const task = await requestProjectTaskCompletion(db, {
        projectId,
        taskId,
        expectedClaimSessionId: sessionId,
        candidateDigest: body.candidate_digest,
        humanReviewApproved: isHumanTaskControlPrincipal({
          sessionId: principalSession,
          authType: c.get('authType'),
        }),
        now: new Date(),
      });
      if (!task) return c.json({ error: 'Task not found' }, 404);
      return c.json({ task: serializeTask(task) }, 200);
    } catch (error) {
      const mapped = completionError(error);
      if (mapped)
        return c.json(
          mapped.body as { error: string; code: string; unmet?: unknown[] },
          mapped.status,
        );
      throw error;
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/tasks/{taskId}/blockers',
    tags: ['tasks'],
    summary: 'List typed task blockers',
    ...auth,
    request: { params: TaskParams },
    responses: {
      200: json(z.object({ blockers: z.array(BlockerSchema) }), 'Task blockers'),
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
    return c.json({
      blockers: (await listProjectTaskBlockers(db, { projectId, taskId })).map(blockerJson),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/blockers',
    tags: ['tasks'],
    summary: 'Create a typed task blocker and reminder',
    ...auth,
    request: {
      params: TaskParams,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                category: z.string().trim().min(1).max(48),
                requested_action: z.string().trim().min(1).max(100_000),
                target: z.record(z.any()).default({}),
                request_digest: z.string().trim().min(1).max(256),
                attempts_made: z.array(z.string().trim().min(1)).max(100).default([]),
                next_reminder_at: z.string().datetime({ offset: true }).nullable().optional(),
                expires_at: z.string().datetime({ offset: true }).nullable().optional(),
                session_id: z.string().trim().min(1).max(256).optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ blocker: BlockerSchema, created: z.boolean() }), 'Task blocker'),
      201: json(z.object({ blocker: BlockerSchema, created: z.boolean() }), 'Task blocker'),
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
    const principalSession = callerKortixSessionId(c);
    const sessionId = principalSession ?? body.session_id ?? null;
    if (principalSession && body.session_id && principalSession !== body.session_id)
      return c.json({ error: 'Session identity mismatch' }, 403);
    if (principalSession) {
      const current = await currentProjectTaskForSession(db, {
        projectId,
        sessionId: principalSession,
      });
      if (!sessionMatchesTaskLineage(current, taskId))
        return c.json({ error: 'Session is outside this task lineage' }, 403);
    }
    let result: Awaited<ReturnType<typeof createProjectTaskBlocker>>;
    try {
      result = await createProjectTaskBlocker(db, {
        projectId,
        taskId,
        category: body.category,
        requestedAction: body.requested_action,
        target: body.target,
        requestDigest: body.request_digest,
        attemptsMade: body.attempts_made,
        nextReminderAt:
          body.next_reminder_at === undefined
            ? undefined
            : body.next_reminder_at === null
              ? null
              : new Date(body.next_reminder_at),
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
        sessionId,
        now: new Date(),
      });
    } catch (error) {
      const mapped = completionError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
    if (result.created && sessionId) {
      try {
        await transitionProjectTask(db, {
          projectId,
          taskId,
          status: 'blocked',
          expectedClaimSessionId: sessionId,
          result: { blocker_id: result.blocker.blockerId },
          now: new Date(),
        });
      } catch {
        /* blocker remains authoritative even if the lease expired */
      }
    }
    return c.json(
      { blocker: blockerJson(result.blocker), created: result.created },
      result.created ? 201 : 200,
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/blockers/{blockerId}/resolve',
    tags: ['tasks'],
    summary: 'Resolve a typed task blocker',
    ...auth,
    request: { params: BlockerParams },
    responses: {
      200: json(z.object({ blocker: BlockerSchema }), 'Resolved blocker'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId, taskId, blockerId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    if (
      !isHumanTaskControlPrincipal({
        sessionId: callerKortixSessionId(c),
        authType: c.get('authType'),
      })
    )
      return c.json({ error: 'A human must resolve this blocker' }, 403);
    const blocker = await resolveProjectTaskBlocker(db, {
      projectId,
      taskId,
      blockerId,
      now: new Date(),
    });
    if (!blocker) return c.json({ error: 'Open blocker not found' }, 404);
    return c.json({ blocker: blockerJson(blocker) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/tasks/{taskId}/events',
    tags: ['tasks'],
    summary: 'List the task event timeline',
    ...auth,
    request: {
      params: TaskParams,
      query: z.object({ limit: z.coerce.number().int().min(1).max(1_000).optional() }).strict(),
    },
    responses: {
      200: json(z.object({ events: z.array(EventSchema) }), 'Task events'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_READ,
    );
    return c.json({
      events: (await listProjectTaskEvents(db, { projectId, taskId, limit })).map(eventJson),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/tasks/{taskId}/sessions',
    tags: ['tasks'],
    summary: 'List task session lineage',
    ...auth,
    request: { params: TaskParams },
    responses: {
      200: json(z.object({ sessions: z.array(SessionLinkSchema) }), 'Task session links'),
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
    return c.json({
      sessions: (await listProjectTaskSessionLinks(db, { projectId, taskId })).map(linkJson),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/tasks/{taskId}/messages',
    tags: ['tasks'],
    summary: 'List task-scoped messages',
    ...auth,
    request: { params: TaskParams },
    responses: {
      200: json(z.object({ messages: z.array(MessageSchema) }), 'Task messages'),
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
    const sessionId = callerKortixSessionId(c);
    return c.json({
      messages: (
        await listProjectTaskMessages(db, {
          projectId,
          taskId,
          ...(sessionId ? { recipientSessionId: sessionId } : {}),
        })
      ).map(messageJson),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/messages',
    tags: ['tasks'],
    summary: 'Send a typed task-scoped message',
    ...auth,
    request: {
      params: TaskParams,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                recipient_session_id: z.string().trim().min(1).nullable().optional(),
                type: z.string().trim().min(1).max(32),
                body: z.record(z.any()),
                correlation_id: z.string().trim().min(1).nullable().optional(),
                idempotency_key: z.string().trim().min(1).max(256),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ message: MessageSchema, created: z.boolean() }), 'Task message'),
      201: json(z.object({ message: MessageSchema, created: z.boolean() }), 'Task message'),
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
    try {
      const result = await sendProjectTaskMessage(db, {
        projectId,
        taskId,
        senderSessionId: callerKortixSessionId(c),
        recipientSessionId: body.recipient_session_id ?? null,
        messageType: body.type,
        body: body.body,
        correlationId: body.correlation_id ?? null,
        idempotencyKey: body.idempotency_key,
        now: new Date(),
      });
      return c.json(
        { message: messageJson(result.message), created: result.created },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = completionError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/messages/{messageId}/ack',
    tags: ['tasks'],
    summary: 'Acknowledge a task message',
    ...auth,
    request: { params: MessageParams },
    responses: {
      200: json(z.object({ message: MessageSchema }), 'Acknowledged message'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const { projectId, taskId, messageId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    const sessionId = callerKortixSessionId(c);
    if (!sessionId) return c.json({ error: 'A session principal is required' }, 403);
    const message = await acknowledgeProjectTaskMessage(db, {
      projectId,
      taskId,
      messageId,
      recipientSessionId: sessionId,
      now: new Date(),
    });
    if (!message) return c.json({ error: 'Message not found' }, 404);
    return c.json({ message: messageJson(message) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/tasks/{taskId}/cancel',
    tags: ['tasks'],
    summary: 'Cancel task responsibility',
    ...auth,
    request: {
      params: TaskParams,
      body: {
        content: {
          'application/json': {
            schema: z.object({ reason: z.string().trim().min(1).max(10_000) }).strict(),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ task: TaskSchema }), 'Canceled task'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, taskId } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    if (
      !isHumanTaskControlPrincipal({
        sessionId: callerKortixSessionId(c),
        authType: c.get('authType'),
      })
    )
      return c.json({ error: 'Only a human can cancel a task' }, 403);
    try {
      const task = await cancelProjectTask(db, {
        projectId,
        taskId,
        actorId: loaded.userId,
        reason,
        now: new Date(),
      });
      if (!task) return c.json({ error: 'Task not found or already terminal' }, 404);
      return c.json({ task: serializeTask(task) });
    } catch (error) {
      const mapped = completionError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/refinements',
    tags: ['tasks'],
    summary: 'List continual-harness refinement proposals',
    ...auth,
    request: { params: ProjectParams },
    responses: {
      200: json(z.object({ refinements: z.array(RefinementSchema) }), 'Refinement proposals'),
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
      PROJECT_ACTIONS.PROJECT_TASK_READ,
    );
    return c.json({
      refinements: (await listProjectTaskRefinements(db, projectId)).map(refinementJson),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/refinements',
    tags: ['tasks'],
    summary: 'Propose a scoped continual-harness refinement',
    ...auth,
    request: {
      params: ProjectParams,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                task_id: z.string().uuid().nullable().optional(),
                scope: z.enum(['task', 'agent', 'project', 'account', 'platform']),
                observation: z.string().trim().min(1).max(100_000),
                base_revision: z.string().trim().min(1).max(256),
                patch: z.record(z.any()),
                evidence_refs: z.array(z.string().trim().min(1)).max(100).default([]),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      201: json(z.object({ refinement: RefinementSchema }), 'Refinement proposal'),
      ...errors(400, 403, 404, 409),
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
    const principalSession = callerKortixSessionId(c);
    if (principalSession && body.scope === 'task') {
      if (!body.task_id)
        return c.json(
          {
            error: 'task scope requires task_id',
            code: 'task_lineage_required',
          },
          409,
        );
      const current = await currentProjectTaskForSession(db, {
        projectId,
        sessionId: principalSession,
      });
      if (!sessionMatchesTaskLineage(current, body.task_id))
        return c.json({ error: 'Session is outside this task lineage' }, 403);
    }
    try {
      const refinement = await proposeProjectTaskRefinement(db, {
        projectId,
        taskId: body.task_id ?? null,
        scope: body.scope,
        observation: body.observation,
        baseRevision: body.base_revision,
        patch: body.patch,
        evidenceRefs: body.evidence_refs,
        sessionId: principalSession,
        now: new Date(),
      });
      return c.json({ refinement: refinementJson(refinement) }, 201);
    } catch (error) {
      const mapped = completionError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/refinements/{proposalId}/rollback',
    tags: ['tasks'],
    summary: 'Rollback an applied task-local refinement',
    ...auth,
    request: { params: RefinementParams },
    responses: {
      200: json(z.object({ refinement: RefinementSchema }), 'Rolled back refinement'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c) => {
    const { projectId, proposalId } = c.req.valid('param');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
    );
    if (
      !isHumanTaskControlPrincipal({
        sessionId: callerKortixSessionId(c),
        authType: c.get('authType'),
      })
    )
      return c.json({ error: 'Only a human can rollback a refinement' }, 403);
    const refinement = await rollbackProjectTaskRefinement(db, {
      projectId,
      proposalId,
      now: new Date(),
    });
    if (!refinement) return c.json({ error: 'Applied task refinement not found' }, 404);
    return c.json({ refinement: refinementJson(refinement) });
  },
);
