import type { Database } from '@kortix/db';
import {
  projectGoalObservations,
  projectSessions,
  projects,
  type projectTaskStatusEnum,
  projectTasks,
  sessionLifecycleCommands,
} from '@kortix/db/schema';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';

export type ProjectTask = typeof projectTasks.$inferSelect;
export type ProjectGoalObservation = typeof projectGoalObservations.$inferSelect;
export type ProjectTaskStatus = (typeof projectTaskStatusEnum.enumValues)[number];

export interface CreateProjectTaskInput {
  projectId: string;
  goalSlug: string;
  parentId?: string | null;
  title: string;
  body?: string;
  status?: ProjectTaskStatus;
  priority?: number;
  assigneeAgent?: string | null;
  assigneeUserId?: string | null;
  blockedBy?: string[];
  origin: string;
  originFingerprint?: string | null;
}

export interface CreateProjectTaskResult {
  task: ProjectTask;
  created: boolean;
}

/**
 * Insert a task once for a generated origin fingerprint.
 *
 * A null fingerprint intentionally disables deduplication. On a fingerprint
 * conflict, this function returns the original row without changing its
 * content. Concurrent retries therefore converge on one durable task.
 */
export async function createProjectTask(
  database: Database,
  input: CreateProjectTaskInput,
): Promise<CreateProjectTaskResult> {
  if (!Number.isSafeInteger(input.priority ?? 0)) {
    throw new RangeError('priority must be a safe integer');
  }

  const [inserted] = await database
    .insert(projectTasks)
    .values({
      projectId: input.projectId,
      goalSlug: input.goalSlug,
      parentId: input.parentId ?? null,
      title: input.title,
      body: input.body ?? '',
      status: input.status ?? 'backlog',
      priority: input.priority ?? 0,
      assigneeAgent: input.assigneeAgent ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      blockedBy: input.blockedBy ?? [],
      origin: input.origin,
      originFingerprint: input.originFingerprint ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { task: inserted, created: true };

  // The only expected conflict is the partial unique fingerprint index. The
  // INSERT waits for a concurrent winner before it returns, so this read sees
  // that committed row under PostgreSQL READ COMMITTED isolation.
  if (input.originFingerprint != null) {
    const [existing] = await database
      .select()
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.projectId, input.projectId),
          eq(projectTasks.originFingerprint, input.originFingerprint),
        ),
      )
      .limit(1);
    if (existing) return { task: existing, created: false };
  }

  throw new Error('project task insert conflicted without a matching origin fingerprint');
}

export async function getProjectTask(
  database: Database,
  input: { projectId: string; taskId: string },
): Promise<ProjectTask | null> {
  const [task] = await database
    .select()
    .from(projectTasks)
    .where(and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)))
    .limit(1);
  return task ?? null;
}

export async function listProjectTasks(
  database: Database,
  input: {
    projectId: string;
    goalSlug?: string;
    statuses?: ProjectTaskStatus[];
    limit?: number;
  },
): Promise<ProjectTask[]> {
  const limit = boundedLimit(input.limit, 100, 1_000);
  return database
    .select()
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.projectId, input.projectId),
        ...(input.goalSlug === undefined ? [] : [eq(projectTasks.goalSlug, input.goalSlug)]),
        ...(input.statuses === undefined || input.statuses.length === 0
          ? []
          : [inArray(projectTasks.status, input.statuses)]),
      ),
    )
    .orderBy(desc(projectTasks.priority), asc(projectTasks.createdAt), asc(projectTasks.taskId))
    .limit(limit);
}

export class TaskClaimConflictError extends Error {
  readonly code = 'TASK_CLAIM_CONFLICT' as const;
  readonly projectId: string;
  readonly taskId: string;

  constructor(projectId: string, taskId: string) {
    super(
      `task ${taskId} in project ${projectId} is not ready, has an unsatisfied dependency or live claim, or does not exist`,
    );
    this.name = 'TaskClaimConflictError';
    this.projectId = projectId;
    this.taskId = taskId;
  }
}

/**
 * Claim ready work with one conditional UPDATE and move it to `doing`.
 *
 * The predicate and write execute in the same PostgreSQL statement. Terminal
 * tasks, tasks with unresolved dependencies, and tasks with a live claim do
 * not match, so a contender cannot overwrite the current owner.
 */
export async function claimProjectTask(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    sessionId: string;
    now: Date;
    leaseMs: number;
  },
): Promise<ProjectTask> {
  assertValidDate(input.now, 'now');
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new RangeError('leaseMs must be a positive safe integer');
  }
  const claimExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  assertValidDate(claimExpiresAt, 'claim expiry');

  const [claimed] = await database
    .update(projectTasks)
    .set({
      status: 'doing',
      claimSessionId: input.sessionId,
      claimedAt: input.now,
      claimExpiresAt,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(projectTasks.projectId, input.projectId),
        eq(projectTasks.taskId, input.taskId),
        inArray(projectTasks.status, ['backlog', 'todo', 'doing']),
        or(
          isNull(projectTasks.claimSessionId),
          and(
            lte(projectTasks.claimExpiresAt, input.now),
            sql`not (${projectTasks.status} = 'doing' and ${projectTasks.livenessWorkerSessionId} is not null)`,
          ),
        ),
        sql`exists (
          select 1
          from ${projectSessions} as claimant_session
          where claimant_session.session_id = ${input.sessionId}
            and claimant_session.project_id = ${projectTasks.projectId}
            and (
              ${projectTasks.assigneeAgent} is null
              or claimant_session.agent_name = ${projectTasks.assigneeAgent}
            )
            and (
              ${projectTasks.assigneeUserId} is null
              or claimant_session.created_by = ${projectTasks.assigneeUserId}
            )
        )`,
        sql`not exists (
          select 1
          from unnest(${projectTasks.blockedBy}) as blocker(task_id)
          left join ${projectTasks} as dependency
            on dependency.project_id = ${projectTasks.projectId}
           and dependency.task_id = blocker.task_id
          where dependency.status is distinct from 'done'::kortix.project_task_status
        )`,
      ),
    )
    .returning();

  if (!claimed) throw new TaskClaimConflictError(input.projectId, input.taskId);
  return claimed;
}

export class TaskTransitionConflictError extends Error {
  readonly code = 'TASK_TRANSITION_CONFLICT' as const;
  readonly projectId: string;
  readonly taskId: string;
  readonly claimSessionId: string | null;
  readonly claimExpiresAt: Date | null;

  constructor(input: {
    projectId: string;
    taskId: string;
    claimSessionId: string | null;
    claimExpiresAt: Date | null;
  }) {
    super(
      `session does not hold a live claim on task ${input.taskId} in project ${input.projectId}`,
    );
    this.name = 'TaskTransitionConflictError';
    this.projectId = input.projectId;
    this.taskId = input.taskId;
    this.claimSessionId = input.claimSessionId;
    this.claimExpiresAt = input.claimExpiresAt;
  }
}

/**
 * Atomically change task status only when the supplied session owns a live claim.
 * Done and blocked transitions release the claim in the same UPDATE.
 */
export async function transitionProjectTask(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    status: ProjectTaskStatus;
    expectedClaimSessionId: string;
    result?: Record<string, unknown>;
    now: Date;
  },
): Promise<ProjectTask | null> {
  assertValidDate(input.now, 'now');
  const clearsClaim = input.status === 'done' || input.status === 'blocked';

  const [transitioned] = await database
    .update(projectTasks)
    .set({
      status: input.status,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(clearsClaim ? { claimSessionId: null, claimedAt: null, claimExpiresAt: null } : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(projectTasks.projectId, input.projectId),
        eq(projectTasks.taskId, input.taskId),
        eq(projectTasks.claimSessionId, input.expectedClaimSessionId),
        gt(projectTasks.claimExpiresAt, input.now),
      ),
    )
    .returning();
  if (transitioned) return transitioned;

  const current = await getProjectTask(database, input);
  if (!current) return null;
  throw new TaskTransitionConflictError({
    projectId: input.projectId,
    taskId: input.taskId,
    claimSessionId: current.claimSessionId,
    claimExpiresAt: current.claimExpiresAt,
  });
}


export interface ProjectTaskWorkerContract {
  max_wall_seconds: number;
  max_tokens: number;
  max_cost_usd: number;
  max_iterations: number;
}

export interface ProjectTaskMeasuredUsage {
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  request_count: number;
}

export class TaskLivenessConflictError extends Error {
  readonly code = 'TASK_LIVENESS_CONFLICT' as const;
  constructor(readonly projectId: string, readonly taskId: string, message: string) {
    super(message);
    this.name = 'TaskLivenessConflictError';
  }
}

function sameWorkerContract(left: unknown, right: ProjectTaskWorkerContract): boolean {
  if (!left || typeof left !== 'object') return false;
  const value = left as Record<string, unknown>;
  return value.max_wall_seconds === right.max_wall_seconds &&
    value.max_tokens === right.max_tokens &&
    value.max_cost_usd === right.max_cost_usd &&
    value.max_iterations === right.max_iterations;
}

/** Atomically bind one immutable worker contract and enqueue its initial prompt. */
export async function registerProjectTaskWorker(
  database: Database,
  input: {
    projectId: string;
    accountId: string;
    taskId: string;
    claimSessionId: string;
    workerSessionId: string;
    actorUserId: string | null;
    prompt: string;
    contract: ProjectTaskWorkerContract;
    now: Date;
  },
): Promise<{ task: ProjectTask; commandId: string; existing: boolean }> {
  assertValidDate(input.now, 'now');
  const deadline = new Date(input.now.getTime() + input.contract.max_wall_seconds * 1_000);
  const idempotencyKey = `task-worker:${input.taskId}:${input.workerSessionId}`;
  const messageId = `task-worker-${input.taskId}-${input.workerSessionId}`;

  return database.transaction(async (tx) => {
    const [bound] = await tx
      .update(projectTasks)
      .set({
        livenessWorkerSessionId: input.workerSessionId,
        livenessCoordinatorSessionId: input.claimSessionId,
        livenessWorkerContract: input.contract,
        livenessStartedAt: input.now,
        livenessDeadlineAt: deadline,
        claimExpiresAt: deadline,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(projectTasks.projectId, input.projectId),
          eq(projectTasks.taskId, input.taskId),
          eq(projectTasks.status, 'doing'),
          eq(projectTasks.claimSessionId, input.claimSessionId),
          gt(projectTasks.claimExpiresAt, input.now),
          isNull(projectTasks.livenessWorkerSessionId),
          sql`exists (
            select 1 from ${projectSessions} worker
            where worker.project_id = ${projectTasks.projectId}
              and worker.session_id = ${input.workerSessionId}
              and worker.session_id <> ${input.claimSessionId}
              and worker.metadata->>'spawned_by_session' = ${input.claimSessionId}
              and coalesce(worker.metadata->>'deletedAt', '') = ''
          )`,
        ),
      )
      .returning();

    let task = bound;
    let existing = false;
    if (!task) {
      const [current] = await tx
        .select()
        .from(projectTasks)
        .where(and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)))
        .limit(1);
      if (
        current?.status === 'doing' &&
        current.claimSessionId === input.claimSessionId &&
        current.claimExpiresAt != null && current.claimExpiresAt > input.now &&
        current.livenessWorkerSessionId === input.workerSessionId &&
        current.livenessCoordinatorSessionId === input.claimSessionId &&
        sameWorkerContract(current.livenessWorkerContract, input.contract)
      ) {
        task = current;
        existing = true;
      } else {
        throw new TaskLivenessConflictError(input.projectId, input.taskId, 'task worker is already bound or the live claim is not owned by this session');
      }
    }

    const [inserted] = await tx
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'continue_session',
        source: 'cli',
        status: 'queued',
        projectId: input.projectId,
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        sessionId: input.workerSessionId,
        idempotencyKey,
        payload: { text: input.prompt, messageId },
        result: {},
        availableAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
      .returning({ commandId: sessionLifecycleCommands.commandId });
    const command = inserted ?? (await tx
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, idempotencyKey))
      .limit(1))[0];
    if (!command) throw new Error('task worker prompt command conflicted but could not be loaded');
    if (existing) {
      const [persisted] = await tx.select({ payload: sessionLifecycleCommands.payload })
        .from(sessionLifecycleCommands)
        .where(eq(sessionLifecycleCommands.commandId, command.commandId))
        .limit(1);
      const payload = (persisted?.payload ?? {}) as Record<string, unknown>;
      if (payload.text !== input.prompt || payload.messageId !== messageId) {
        throw new TaskLivenessConflictError(input.projectId, input.taskId, 'registered worker prompt is immutable');
      }
    }
    return { task, commandId: command.commandId, existing };
  });
}

export async function recordProjectTaskProgress(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    claimSessionId: string;
    workerSessionId: string;
    ref: string;
    now: Date;
  },
): Promise<ProjectTask> {
  const [task] = await database.update(projectTasks).set({
    lastProgressAt: input.now,
    lastProgressRef: input.ref,
    updatedAt: input.now,
  }).where(and(
    eq(projectTasks.projectId, input.projectId),
    eq(projectTasks.taskId, input.taskId),
    eq(projectTasks.status, 'doing'),
    eq(projectTasks.claimSessionId, input.claimSessionId),
    eq(projectTasks.livenessWorkerSessionId, input.workerSessionId),
    gt(projectTasks.claimExpiresAt, input.now),
  )).returning();
  if (!task) throw new TaskLivenessConflictError(input.projectId, input.taskId, 'task has no matching live worker binding');
  return task;
}

function exceededWorkerBounds(task: ProjectTask, usage: ProjectTaskMeasuredUsage, now: Date): string | null {
  const contract = task.livenessWorkerContract;
  if (!contract || !task.livenessDeadlineAt) return 'worker contract is unavailable';
  if (now >= task.livenessDeadlineAt) return 'max_wall_seconds exceeded';
  if (usage.total_tokens >= contract.max_tokens) return 'max_tokens exceeded';
  if (usage.total_cost >= contract.max_cost_usd) return 'max_cost_usd exceeded';
  if (task.livenessIterationsAdmitted >= contract.max_iterations) return 'max_iterations exceeded';
  return null;
}

/**
 * Record one idempotent no-progress settlement. The first distinct settlement
 * queues one continuation. The next settlement or an exceeded bound blocks and
 * releases the task in the same transaction that queues escalation.
 */
export async function settleProjectTaskNoProgress(
  database: Database,
  input: {
    projectId: string;
    accountId: string;
    taskId: string;
    claimSessionId: string;
    workerSessionId: string;
    actorUserId: string | null;
    settlementId: string;
    reason: string;
    measuredUsage: ProjectTaskMeasuredUsage;
    now: Date;
  },
): Promise<{ task: ProjectTask; action: 'continuation_queued' | 'blocked_escalation_queued'; commandId: string }> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select task_id from ${projectTasks}
      where project_id = ${input.projectId} and task_id = ${input.taskId} for update`);
    const task = (await tx.select().from(projectTasks).where(and(
      eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId),
    )).limit(1))[0];
    if (!task) throw new TaskLivenessConflictError(input.projectId, input.taskId, 'task not found');
    if (
      task.livenessCoordinatorSessionId !== input.claimSessionId ||
      task.livenessWorkerSessionId !== input.workerSessionId
    ) {
      throw new TaskLivenessConflictError(input.projectId, input.taskId, 'task has no matching worker binding');
    }
    if (task.lastNoProgressSettlementId === input.settlementId && task.lastNoProgressAction && task.lastNoProgressCommandId) {
      return {
        task,
        action: task.lastNoProgressAction as 'continuation_queued' | 'blocked_escalation_queued',
        commandId: task.lastNoProgressCommandId,
      };
    }
    if (task.status !== 'doing' || task.claimSessionId !== input.claimSessionId ||
        task.livenessWorkerSessionId !== input.workerSessionId || !task.claimExpiresAt || task.claimExpiresAt <= input.now) {
      throw new TaskLivenessConflictError(input.projectId, input.taskId, 'task has no matching live worker binding');
    }

    const exceeded = exceededWorkerBounds(task, input.measuredUsage, input.now);
    const escalates = exceeded != null || task.continuationConsumedAt != null;
    const action = escalates ? 'blocked_escalation_queued' as const : 'continuation_queued' as const;
    const idempotencyKey = escalates
      ? `task-escalate:${input.taskId}:${input.settlementId}`
      : `task-no-progress:${input.taskId}:${input.workerSessionId}`;
    const targetSessionId = escalates ? input.claimSessionId : input.workerSessionId;
    const text = escalates
      ? `Task ${input.taskId} is blocked. ${exceeded ?? input.reason}. Escalate through the existing review, question, or channel path.`
      : `Continue task ${input.taskId} once. Previous settlement made no progress: ${input.reason}. Return verifier evidence or a delivered blocker within the registered bounds.`;
    const [command] = await tx.insert(sessionLifecycleCommands).values({
      commandType: 'continue_session', source: 'cli', status: 'queued',
      projectId: input.projectId, accountId: input.accountId, actorUserId: input.actorUserId,
      sessionId: targetSessionId, idempotencyKey,
      payload: { text, messageId: idempotencyKey }, result: {}, availableAt: input.now, updatedAt: input.now,
    }).onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
      .returning({ commandId: sessionLifecycleCommands.commandId });
    const persistedCommand = command ?? (await tx.select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.idempotencyKey, idempotencyKey)).limit(1))[0];
    if (!persistedCommand) throw new Error('liveness command conflicted but could not be loaded');

    if (escalates) {
      await tx.insert(sessionLifecycleCommands).values({
        commandType: 'stop_session', source: 'cli', status: 'queued',
        projectId: input.projectId, accountId: input.accountId, actorUserId: input.actorUserId,
        sessionId: input.workerSessionId,
        idempotencyKey: `task-stop:${input.taskId}:${input.workerSessionId}`,
        payload: { reason: 'task_liveness_exhausted' }, result: {},
        availableAt: input.now, updatedAt: input.now,
      }).onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    const blocker = exceeded ?? input.reason;
    const [updated] = await tx.update(projectTasks).set({
      noProgressSettlements: Math.min(2, task.noProgressSettlements + 1),
      lastNoProgressSettlementId: input.settlementId,
      lastNoProgressAction: action,
      lastNoProgressCommandId: persistedCommand.commandId,
      ...(escalates ? {
        status: 'blocked' as const,
        escalatedAt: input.now,
        livenessBlocker: blocker,
        result: { ...task.result, liveness: { blocker, measured_usage: input.measuredUsage } },
        claimSessionId: null,
        claimedAt: null,
        claimExpiresAt: null,
      } : { continuationConsumedAt: input.now }),
      updatedAt: input.now,
    }).where(and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId))).returning();
    if (!updated) throw new Error('locked task disappeared during liveness settlement');
    return { task: updated, action, commandId: persistedCommand.commandId };
  });
}


export class TaskLivenessLimitExceededError extends Error {
  readonly code = 'TASK_LIVENESS_LIMIT_EXCEEDED' as const;
  constructor(readonly taskId: string) {
    super(`worker bounds exhausted for task ${taskId}`);
    this.name = 'TaskLivenessLimitExceededError';
  }
}

export async function projectTaskWorkerIsBound(
  database: Database,
  workerSessionId: string,
): Promise<boolean> {
  const [row] = await database.select({ taskId: projectTasks.taskId }).from(projectTasks).where(and(
    eq(projectTasks.livenessWorkerSessionId, workerSessionId),
    eq(projectTasks.status, 'doing'),
  )).limit(1);
  return Boolean(row);
}

/** Atomically admit one gateway request against the persisted iteration cap. */
export async function admitProjectTaskWorkerIteration(
  database: Database,
  input: { workerSessionId: string; usage: ProjectTaskMeasuredUsage; now: Date },
): Promise<{ taskId: string; admitted: boolean } | null> {
  const [row] = await database.select({ task: projectTasks, accountId: projects.accountId })
    .from(projectTasks)
    .innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
    .where(and(
      eq(projectTasks.livenessWorkerSessionId, input.workerSessionId),
      eq(projectTasks.status, 'doing'),
    )).limit(1);
  if (!row) return null;
  const active = row.task;
  const contract = active.livenessWorkerContract;
  if (!contract) throw new TaskLivenessLimitExceededError(active.taskId);
  const [admitted] = await database.update(projectTasks).set({
    livenessIterationsAdmitted: sql`${projectTasks.livenessIterationsAdmitted} + 1`,
    updatedAt: input.now,
  }).where(and(
    eq(projectTasks.taskId, active.taskId),
    eq(projectTasks.status, 'doing'),
    gt(projectTasks.livenessDeadlineAt, input.now),
    sql`${projectTasks.livenessIterationsAdmitted} < (${projectTasks.livenessWorkerContract}->>'max_iterations')::integer`,
    sql`${input.usage.total_tokens} < (${projectTasks.livenessWorkerContract}->>'max_tokens')::numeric`,
    sql`${input.usage.total_cost} < (${projectTasks.livenessWorkerContract}->>'max_cost_usd')::numeric`,
  )).returning({ taskId: projectTasks.taskId });
  if (!admitted) {
    const fresh = await getProjectTask(database, { projectId: active.projectId, taskId: active.taskId });
    if (fresh?.status === 'doing') {
      const reason = exceededWorkerBounds(fresh, input.usage, input.now) ?? 'worker admission bound exhausted';
      await finalizeTaskLiveness(database, fresh, {
        accountId: row.accountId,
        reason,
        usage: input.usage,
        now: input.now,
      });
    }
    throw new TaskLivenessLimitExceededError(active.taskId);
  }
  return { taskId: admitted.taskId, admitted: true };
}


async function finalizeTaskLiveness(
  database: Database,
  task: ProjectTask,
  input: { accountId: string; reason: string; usage?: ProjectTaskMeasuredUsage; now: Date },
): Promise<boolean> {
  if (!task.livenessWorkerSessionId || !task.livenessCoordinatorSessionId) return false;
  return database.transaction(async (tx) => {
    const [blocked] = await tx.update(projectTasks).set({
      status: 'blocked',
      escalatedAt: input.now,
      livenessBlocker: input.reason,
      result: { ...task.result, liveness: { blocker: input.reason, measured_usage: input.usage ?? null } },
      claimSessionId: null,
      claimedAt: null,
      claimExpiresAt: null,
      updatedAt: input.now,
    }).where(and(eq(projectTasks.taskId, task.taskId), eq(projectTasks.status, 'doing'))).returning();
    if (!blocked) return false;
    await tx.insert(sessionLifecycleCommands).values([
      {
        commandType: 'stop_session', source: 'cli', status: 'queued' as const,
        projectId: task.projectId, accountId: input.accountId,
        sessionId: task.livenessWorkerSessionId,
        idempotencyKey: `task-stop:${task.taskId}:${task.livenessWorkerSessionId}`,
        payload: { reason: 'task_liveness_exhausted' }, result: {}, availableAt: input.now, updatedAt: input.now,
      },
      {
        commandType: 'continue_session', source: 'cli', status: 'queued' as const,
        projectId: task.projectId, accountId: input.accountId,
        sessionId: task.livenessCoordinatorSessionId,
        idempotencyKey: `task-bound-escalate:${task.taskId}`,
        payload: {
          text: `Task ${task.taskId} is blocked: ${input.reason}. Escalate through the existing review, question, or channel path.`,
          messageId: `task-bound-escalate:${task.taskId}`,
        },
        result: {}, availableAt: input.now, updatedAt: input.now,
      },
    ]).onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    return true;
  });
}

export async function finalizeProjectTaskLivenessIfExceeded(
  database: Database,
  input: { workerSessionId: string; usage: ProjectTaskMeasuredUsage; now: Date },
): Promise<boolean> {
  const [row] = await database.select({ task: projectTasks, accountId: projects.accountId })
    .from(projectTasks).innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
    .where(and(eq(projectTasks.livenessWorkerSessionId, input.workerSessionId), eq(projectTasks.status, 'doing')))
    .limit(1);
  if (!row) return false;
  const reason = exceededWorkerBounds(row.task, input.usage, input.now);
  if (!reason) return false;
  return finalizeTaskLiveness(database, row.task, { accountId: row.accountId, reason, usage: input.usage, now: input.now });
}

export async function sweepTaskLivenessBounds(
  database: Database,
  now = new Date(),
  limit = 100,
  loadUsage?: (input: { accountId: string; sessionId: string }) => Promise<ProjectTaskMeasuredUsage>,
): Promise<number> {
  const rows = await database.select({ task: projectTasks, accountId: projects.accountId })
    .from(projectTasks).innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
    .where(and(
      eq(projectTasks.status, 'doing'),
      sql`${projectTasks.livenessWorkerSessionId} is not null`,
    )).limit(limit);
  let finalized = 0;
  for (const row of rows) {
    const workerSessionId = row.task.livenessWorkerSessionId!;
    const usage = loadUsage ? await loadUsage({ accountId: row.accountId, sessionId: workerSessionId }) : undefined;
    const reason = usage
      ? exceededWorkerBounds(row.task, usage, now)
      : row.task.livenessDeadlineAt && row.task.livenessDeadlineAt <= now
        ? 'max_wall_seconds exceeded'
        : null;
    if (reason && await finalizeTaskLiveness(database, row.task, {
      accountId: row.accountId,
      reason,
      usage,
      now,
    })) finalized += 1;
  }
  return finalized;
}

export async function recordProjectGoalObservation(
  database: Database,
  input: {
    projectId: string;
    goalSlug: string;
    metric: string;
    value: number;
    source: string;
    sessionId?: string | null;
    observedAt: Date;
  },
): Promise<ProjectGoalObservation> {
  if (!Number.isFinite(input.value)) throw new RangeError('value must be finite');
  assertValidDate(input.observedAt, 'observedAt');

  const [observation] = await database
    .insert(projectGoalObservations)
    .values({
      projectId: input.projectId,
      goalSlug: input.goalSlug,
      metric: input.metric,
      value: input.value,
      source: input.source,
      sessionId: input.sessionId ?? null,
      observedAt: input.observedAt,
    })
    .returning();
  if (!observation) throw new Error('project goal observation insert returned no row');
  return observation;
}

export async function listProjectGoalObservations(
  database: Database,
  input: {
    projectId: string;
    goalSlug: string;
    metric: string;
    from: Date;
    to: Date;
    limit?: number;
  },
): Promise<ProjectGoalObservation[]> {
  assertValidDate(input.from, 'from');
  assertValidDate(input.to, 'to');
  if (input.from > input.to) throw new RangeError('from must be before or equal to to');
  const limit = boundedLimit(input.limit, 1_000, 10_000);

  return database
    .select()
    .from(projectGoalObservations)
    .where(
      and(
        eq(projectGoalObservations.projectId, input.projectId),
        eq(projectGoalObservations.goalSlug, input.goalSlug),
        eq(projectGoalObservations.metric, input.metric),
        gte(projectGoalObservations.observedAt, input.from),
        lte(projectGoalObservations.observedAt, input.to),
      ),
    )
    .orderBy(asc(projectGoalObservations.observedAt), asc(projectGoalObservations.observationId))
    .limit(limit);
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) {
    throw new RangeError(`limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
}
