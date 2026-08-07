import type { Database } from '@kortix/db';
import {
  accountTokens,
  projectGoalObservations,
  projectSessions,
  projects,
  projectTaskNoProgressSettlements,
  type projectTaskStatusEnum,
  projectTasks,
  sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db/schema';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { normalizeOpenCodeMessageId } from './session-lifecycle/opencode-message-id';

export type ProjectTask = typeof projectTasks.$inferSelect;
export type ProjectGoalObservation = typeof projectGoalObservations.$inferSelect;
export type ProjectTaskStatus = (typeof projectTaskStatusEnum.enumValues)[number];

export class TaskWorkerReservationConflictError extends Error {
  readonly code = 'TASK_WORKER_RESERVATION_CONFLICT' as const;
  constructor(readonly projectId: string, readonly coordinatorSessionId: string) {
    super('the coordinator already has an active task worker reservation');
    this.name = 'TaskWorkerReservationConflictError';
  }
}

/**
 * Serialize reservation creation per coordinator and reject a second active
 * child. Call this inside the same transaction that inserts project_sessions.
 */
export async function assertTaskWorkerReservationSlot(
  database: Database,
  input: { projectId: string; coordinatorSessionId: string; now: Date },
): Promise<void> {
  assertValidDate(input.now, 'now');
  const lockKey = `task-worker-reservation:${input.projectId}:${input.coordinatorSessionId}`;
  await database.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const [existing] = await database
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.projectId, input.projectId),
      inArray(projectSessions.status, ['queued', 'branching', 'provisioning', 'running']),
      sql`${projectSessions.metadata}->>'spawned_by_session' = ${input.coordinatorSessionId}`,
      sql`${projectSessions.metadata}->>'task_liveness_binding_required' = 'true'`,
      sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`,
      sql`(
        ${projectSessions.metadata}->>'task_liveness_binding_status' = 'bound'
        or (
          ${projectSessions.metadata}->>'task_liveness_binding_status' = 'pending'
          and (${projectSessions.metadata}->>'task_liveness_reservation_expires_at')::timestamptz > ${input.now.toISOString()}
        )
      )`,
    ))
    .limit(1);
  if (existing) {
    throw new TaskWorkerReservationConflictError(input.projectId, input.coordinatorSessionId);
  }
}

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

  try {
    return await database.transaction(async (tx) => {
      // The session row is the PostgreSQL mutex for coordinator ownership.
      // It serializes claims on different task rows made by the same session.
      await tx.execute(sql`select session_id from ${projectSessions}
        where project_id = ${input.projectId} and session_id = ${input.sessionId}
        for update`);

      // An unbound expired claim no longer owns coordinator capacity. Clear it
      // under the same session mutex before attempting the next claim.
      await tx.update(projectTasks).set({
        claimSessionId: null,
        claimedAt: null,
        claimExpiresAt: null,
        updatedAt: input.now,
      }).where(and(
        eq(projectTasks.projectId, input.projectId),
        eq(projectTasks.claimSessionId, input.sessionId),
        lte(projectTasks.claimExpiresAt, input.now),
        isNull(projectTasks.livenessWorkerSessionId),
      ));

      const [claimed] = await tx
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
            sql`not exists (
              select 1 from ${projectTasks} as active_claim
              where active_claim.project_id = ${projectTasks.projectId}
                and active_claim.claim_session_id = ${input.sessionId}
                and active_claim.status = 'doing'::kortix.project_task_status
                and active_claim.task_id <> ${projectTasks.taskId}
            )`,
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
                and coalesce(claimant_session.metadata->>'spawned_by_session', '') = ''
                and coalesce(claimant_session.metadata->>'deletedAt', '') = ''
                and not exists (
                  select 1 from ${projectTasks} worker_binding
                  where worker_binding.liveness_worker_session_id = claimant_session.session_id
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
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === '23505') {
      throw new TaskClaimConflictError(input.projectId, input.taskId);
    }
    throw error;
  }
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

export class TaskGitWriteInFlightError extends Error {
  readonly code = 'TASK_GIT_WRITE_IN_FLIGHT' as const;

  constructor(readonly taskId: string, readonly leaseExpiresAt: Date) {
    super(`task ${taskId} has a Git write in flight until ${leaseExpiresAt.toISOString()}`);
    this.name = 'TaskGitWriteInFlightError';
  }
}

function noLiveTaskGitWrite(now: Date) {
  return or(
    isNull(projectTasks.gitWriteRequestId),
    lte(projectTasks.gitWriteLeaseExpiresAt, now),
  );
}

function noLiveTaskLivenessAdmission(now: Date) {
  return or(
    isNull(projectTasks.livenessAdmissionId),
    lte(projectTasks.livenessAdmissionExpiresAt, now),
  );
}

async function revokeWorkerSessionTokens(
  database: Pick<Database, 'update'>,
  workerSessionId: string,
  accountId: string,
  now: Date,
): Promise<void> {
  await database.update(accountTokens).set({
    status: 'revoked',
    revokedAt: now,
  }).where(and(
    eq(accountTokens.sessionId, workerSessionId),
    eq(accountTokens.accountId, accountId),
    eq(accountTokens.status, 'active'),
  ));
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

  const transitioned = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(projectTasks)
      .set({
        status: input.status,
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(clearsClaim ? {
          claimSessionId: null,
          claimedAt: null,
          claimExpiresAt: null,
          livenessAdmissionId: null,
          livenessAdmissionExpiresAt: null,
          gitWriteRequestId: null,
          gitWriteLeaseExpiresAt: null,
        } : {}),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(projectTasks.projectId, input.projectId),
          eq(projectTasks.taskId, input.taskId),
          eq(projectTasks.claimSessionId, input.expectedClaimSessionId),
          gt(projectTasks.claimExpiresAt, input.now),
          ...(clearsClaim
            ? [noLiveTaskGitWrite(input.now), noLiveTaskLivenessAdmission(input.now)]
            : []),
        ),
      )
      .returning();
    if (!row || !clearsClaim || !row.livenessWorkerSessionId) return row;

    const [project] = await tx
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
    if (!project) throw new Error(`project ${input.projectId} disappeared during task transition`);
    // The worker's bearer authority ends in the same transaction as its task.
    // The stop command may take seconds to drain; no API or connector call may
    // remain authorized during that delay.
    await revokeWorkerSessionTokens(
      tx,
      row.livenessWorkerSessionId,
      project.accountId,
      input.now,
    );
    await tx
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'stop_session',
        source: 'cli',
        status: 'queued',
        projectId: input.projectId,
        accountId: project.accountId,
        sessionId: row.livenessWorkerSessionId,
        idempotencyKey: `task-stop:${row.taskId}:${row.livenessWorkerSessionId}`,
        payload: { reason: 'task_terminal' },
        result: {},
        availableAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    return row;
  });
  if (transitioned) return transitioned;

  const current = await getProjectTask(database, input);
  if (!current) return null;
  if (
    clearsClaim &&
    current.gitWriteRequestId &&
    current.gitWriteLeaseExpiresAt &&
    current.gitWriteLeaseExpiresAt > input.now
  ) {
    throw new TaskGitWriteInFlightError(current.taskId, current.gitWriteLeaseExpiresAt);
  }
  if (
    clearsClaim &&
    current.livenessAdmissionId &&
    current.livenessAdmissionExpiresAt &&
    current.livenessAdmissionExpiresAt > input.now
  ) {
    throw new TaskLivenessRequestInFlightError(current.taskId, current.livenessAdmissionExpiresAt);
  }
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

/**
 * Atomically bind one immutable worker contract, authorize its reservation, and
 * enqueue runtime provisioning before its initial prompt.
 */
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
): Promise<{
  task: ProjectTask;
  commandId: string;
  provisionCommandId: string;
  existing: boolean;
}> {
  assertValidDate(input.now, 'now');
  const deadline = new Date(input.now.getTime() + input.contract.max_wall_seconds * 1_000);
  const promptIdempotencyKey = `task-worker:${input.taskId}:${input.workerSessionId}`;
  const provisionIdempotencyKey = `task-worker-provision:${input.taskId}:${input.workerSessionId}`;
  const messageId = normalizeOpenCodeMessageId(`task-worker-${input.taskId}-${input.workerSessionId}`);

  return database.transaction(async (tx) => {
    const [bound] = await tx
      .update(projectTasks)
      .set({
        livenessWorkerSessionId: input.workerSessionId,
        livenessCoordinatorSessionId: input.claimSessionId,
        livenessWorkerContract: input.contract,
        livenessStartedAt: input.now,
        livenessDeadlineAt: deadline,
        // The coordinator claim remains valid for the complete immutable worker
        // contract. This also satisfies project_tasks_claim_covers_liveness.
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
            select 1 from ${projectSessions} coordinator
            where coordinator.project_id = ${projectTasks.projectId}
              and coordinator.session_id = ${input.claimSessionId}
              and coalesce(coordinator.metadata->>'spawned_by_session', '') = ''
              and coalesce(coordinator.metadata->>'deletedAt', '') = ''
          )`,
          sql`exists (
            select 1 from ${projectSessions} worker
            where worker.project_id = ${projectTasks.projectId}
              and worker.session_id = ${input.workerSessionId}
              and worker.session_id <> ${input.claimSessionId}
              and worker.metadata->>'spawned_by_session' = ${input.claimSessionId}
              and worker.metadata->>'task_liveness_binding_required' = 'true'
              and worker.metadata->>'task_liveness_binding_status' = 'pending'
              and (worker.metadata->>'task_liveness_reservation_expires_at')::timestamptz > ${input.now.toISOString()}
              and coalesce(worker.metadata->>'deletedAt', '') = ''
              and worker.status = 'queued'
              and not exists (
                select 1 from ${sessionSandboxes} reserved_runtime
                where reserved_runtime.session_id = worker.session_id
              )
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

    if (!existing) {
      const [authorized] = await tx
        .update(projectSessions)
        .set({
          metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || jsonb_build_object(
            'task_liveness_binding_status', 'bound',
            'task_liveness_bound_task_id', ${sql`${input.taskId}::text`},
            'task_liveness_bound_at', ${sql`${input.now.toISOString()}::text`}
          )`,
          updatedAt: input.now,
        })
        .where(and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.sessionId, input.workerSessionId),
          eq(projectSessions.status, 'queued'),
          sql`${projectSessions.metadata}->>'task_liveness_binding_status' = 'pending'`,
          sql`${projectSessions.metadata}->>'spawned_by_session' = ${input.claimSessionId}`,
        ))
        .returning({ sessionId: projectSessions.sessionId });
      if (!authorized) {
        throw new TaskLivenessConflictError(input.projectId, input.taskId, 'worker reservation is no longer pending');
      }
    } else {
      const [authorized] = await tx
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.sessionId, input.workerSessionId),
        ))
        .limit(1);
      const metadata = (authorized?.metadata ?? {}) as Record<string, unknown>;
      if (
        metadata.task_liveness_binding_status !== 'bound' ||
        metadata.task_liveness_bound_task_id !== input.taskId
      ) {
        throw new TaskLivenessConflictError(input.projectId, input.taskId, 'worker reservation binding is immutable');
      }
    }

    const [insertedProvision] = await tx
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'provision_session',
        source: 'cli',
        status: 'queued',
        projectId: input.projectId,
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        sessionId: input.workerSessionId,
        idempotencyKey: provisionIdempotencyKey,
        payload: { taskId: input.taskId, reservation: true },
        result: {},
        availableAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
      .returning({ commandId: sessionLifecycleCommands.commandId });
    const provisionCommand = insertedProvision ?? (await tx
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, provisionIdempotencyKey))
      .limit(1))[0];
    if (!provisionCommand) throw new Error('task worker provision command conflicted but could not be loaded');

    const [insertedPrompt] = await tx
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'continue_session',
        source: 'cli',
        status: 'queued',
        projectId: input.projectId,
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        sessionId: input.workerSessionId,
        idempotencyKey: promptIdempotencyKey,
        payload: { text: input.prompt, messageId },
        result: {},
        // Stable ordering lets a normal batch drain kick provisioning before it
        // starts the readiness wait for the first prompt.
        availableAt: new Date(input.now.getTime() + 1),
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
      .returning({ commandId: sessionLifecycleCommands.commandId });
    const promptCommand = insertedPrompt ?? (await tx
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, promptIdempotencyKey))
      .limit(1))[0];
    if (!promptCommand) throw new Error('task worker prompt command conflicted but could not be loaded');
    if (existing) {
      const [persisted] = await tx.select({ payload: sessionLifecycleCommands.payload })
        .from(sessionLifecycleCommands)
        .where(eq(sessionLifecycleCommands.commandId, promptCommand.commandId))
        .limit(1);
      const payload = (persisted?.payload ?? {}) as Record<string, unknown>;
      const persistedMessageId = typeof payload.messageId === 'string'
        ? normalizeOpenCodeMessageId(payload.messageId)
        : payload.messageId;
      if (payload.text !== input.prompt || persistedMessageId !== messageId) {
        throw new TaskLivenessConflictError(input.projectId, input.taskId, 'registered worker prompt is immutable');
      }
    }
    return {
      task,
      commandId: promptCommand.commandId,
      provisionCommandId: provisionCommand.commandId,
      existing,
    };
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

const PROJECT_TASK_DATE_KEYS = [
  'claimedAt',
  'claimExpiresAt',
  'livenessStartedAt',
  'livenessDeadlineAt',
  'livenessAdmissionExpiresAt',
  'gitWriteLeaseExpiresAt',
  'livenessLastSweptAt',
  'continuationConsumedAt',
  'lastProgressAt',
  'escalatedAt',
  'createdAt',
  'updatedAt',
] as const;

function serializeProjectTaskSnapshot(task: ProjectTask): Record<string, unknown> {
  return JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
}

function hydrateProjectTaskSnapshot(snapshot: Record<string, unknown>): ProjectTask {
  const task = { ...snapshot } as unknown as ProjectTask;
  for (const key of PROJECT_TASK_DATE_KEYS) {
    const value = snapshot[key];
    (task as unknown as Record<string, unknown>)[key] =
      typeof value === 'string' ? new Date(value) : null;
  }
  return task;
}

function settlementResultFromLedger(
  settlement: typeof projectTaskNoProgressSettlements.$inferSelect,
): ProjectTaskNoProgressResult {
  return {
    task: hydrateProjectTaskSnapshot(settlement.taskSnapshot),
    action: settlement.action as ProjectTaskNoProgressResult['action'],
    commandId: settlement.commandId,
    measuredUsage: settlement.measuredUsage,
  };
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

export interface ProjectTaskNoProgressResult {
  task: ProjectTask;
  action: 'continuation_queued' | 'blocked_escalation_queued';
  commandId: string;
  measuredUsage: ProjectTaskMeasuredUsage;
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
): Promise<ProjectTaskNoProgressResult> {
  return database.transaction(async (tx) => {
    const loadSettlement = async () => (await tx.select()
      .from(projectTaskNoProgressSettlements)
      .where(and(
        eq(projectTaskNoProgressSettlements.projectId, input.projectId),
        eq(projectTaskNoProgressSettlements.taskId, input.taskId),
        eq(projectTaskNoProgressSettlements.settlementId, input.settlementId),
      ))
      .limit(1))[0];
    const replay = await loadSettlement();
    if (replay) {
      if (replay.claimSessionId !== input.claimSessionId || replay.workerSessionId !== input.workerSessionId) {
        throw new TaskLivenessConflictError(input.projectId, input.taskId, 'settlement belongs to another worker binding');
      }
      return settlementResultFromLedger(replay);
    }

    await tx.execute(sql`select task_id from ${projectTasks}
      where project_id = ${input.projectId} and task_id = ${input.taskId} for update`);
    const concurrentReplay = await loadSettlement();
    if (concurrentReplay) {
      if (
        concurrentReplay.claimSessionId !== input.claimSessionId ||
        concurrentReplay.workerSessionId !== input.workerSessionId
      ) {
        throw new TaskLivenessConflictError(input.projectId, input.taskId, 'settlement belongs to another worker binding');
      }
      return settlementResultFromLedger(concurrentReplay);
    }
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
    if (task.status !== 'doing' || task.claimSessionId !== input.claimSessionId ||
        task.livenessWorkerSessionId !== input.workerSessionId || !task.claimExpiresAt || task.claimExpiresAt <= input.now) {
      throw new TaskLivenessConflictError(input.projectId, input.taskId, 'task has no matching live worker binding');
    }

    const exceeded = exceededWorkerBounds(task, input.measuredUsage, input.now);
    const escalates = exceeded != null || task.continuationConsumedAt != null;
    if (
      escalates &&
      task.gitWriteRequestId &&
      task.gitWriteLeaseExpiresAt &&
      task.gitWriteLeaseExpiresAt > input.now
    ) {
      throw new TaskGitWriteInFlightError(task.taskId, task.gitWriteLeaseExpiresAt);
    }
    if (
      escalates &&
      task.livenessAdmissionId &&
      task.livenessAdmissionExpiresAt &&
      task.livenessAdmissionExpiresAt > input.now
    ) {
      throw new TaskLivenessRequestInFlightError(task.taskId, task.livenessAdmissionExpiresAt);
    }
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
      payload: { text, messageId: normalizeOpenCodeMessageId(idempotencyKey) }, result: {}, availableAt: input.now, updatedAt: input.now,
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
        livenessAdmissionId: null,
        livenessAdmissionExpiresAt: null,
        gitWriteRequestId: null,
        gitWriteLeaseExpiresAt: null,
      } : { continuationConsumedAt: input.now }),
      updatedAt: input.now,
    }).where(and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId))).returning();
    if (!updated) throw new Error('locked task disappeared during liveness settlement');
    if (escalates) {
      await revokeWorkerSessionTokens(tx, input.workerSessionId, input.accountId, input.now);
    }
    const [settlement] = await tx.insert(projectTaskNoProgressSettlements).values({
      projectId: input.projectId,
      taskId: input.taskId,
      settlementId: input.settlementId,
      claimSessionId: input.claimSessionId,
      workerSessionId: input.workerSessionId,
      action,
      commandId: persistedCommand.commandId,
      taskSnapshot: serializeProjectTaskSnapshot(updated),
      measuredUsage: input.measuredUsage,
      createdAt: input.now,
    }).returning();
    if (!settlement) throw new Error('liveness settlement ledger insert returned no row');
    return settlementResultFromLedger(settlement);
  });
}


export class TaskLivenessLimitExceededError extends Error {
  readonly code = 'TASK_LIVENESS_LIMIT_EXCEEDED' as const;
  constructor(readonly taskId: string) {
    super(`worker bounds exhausted for task ${taskId}`);
    this.name = 'TaskLivenessLimitExceededError';
  }
}

export type ProjectTaskWorkerAdmissionState = 'bound' | 'spawned_unbound' | 'not_worker';

export class TaskLivenessWorkerUnboundError extends Error {
  readonly code = 'TASK_LIVENESS_WORKER_UNBOUND' as const;
  constructor(readonly workerSessionId: string) {
    super(`spawned worker session ${workerSessionId} is not registered to a bounded task`);
    this.name = 'TaskLivenessWorkerUnboundError';
  }
}

/**
 * Classify a session and its committed task binding in one PostgreSQL snapshot.
 * A spawned child fails closed until registerProjectTaskWorker commits.
 */
export async function projectTaskWorkerAdmissionState(
  database: Database,
  workerSessionId: string,
): Promise<ProjectTaskWorkerAdmissionState> {
  const [row] = await database
    .select({
      metadata: projectSessions.metadata,
      taskId: projectTasks.taskId,
    })
    .from(projectSessions)
    .leftJoin(projectTasks, eq(projectTasks.livenessWorkerSessionId, projectSessions.sessionId))
    .where(eq(projectSessions.sessionId, workerSessionId))
    .limit(1);
  if (!row) return 'not_worker';
  if (row.taskId) return 'bound';
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return metadata.task_liveness_binding_required === true
    ? 'spawned_unbound'
    : 'not_worker';
}

export interface ProjectTaskWorkerBinding {
  taskId: string;
  status: ProjectTaskStatus;
}

/** The worker identity remains bound after its task becomes terminal. */
export async function getProjectTaskWorkerBinding(
  database: Database,
  workerSessionId: string,
): Promise<ProjectTaskWorkerBinding | null> {
  const [row] = await database
    .select({ taskId: projectTasks.taskId, status: projectTasks.status })
    .from(projectTasks)
    .where(eq(projectTasks.livenessWorkerSessionId, workerSessionId))
    .limit(1);
  return row ?? null;
}

export async function projectTaskWorkerIsBound(
  database: Database,
  workerSessionId: string,
): Promise<boolean> {
  return Boolean(await getProjectTaskWorkerBinding(database, workerSessionId));
}

/**
 * Acquire the one durable receive-pack lease for a doing task worker.
 *
 * The lease expires at the immutable worker wall deadline. A crashed proxy can
 * therefore block terminalization only until the task must stop. The single
 * conditional UPDATE is the cross-replica mutex; there is no memory lock and no
 * database transaction held across the upstream network request.
 */
export async function acquireProjectTaskGitWrite(
  database: Database,
  input: { projectId: string; workerSessionId: string; requestId: string; now: Date },
): Promise<{
  taskId: string;
  requestId: string;
  leaseExpiresAt: Date;
} | null> {
  assertValidDate(input.now, 'now');
  const [admitted] = await database.update(projectTasks).set({
    gitWriteRequestId: input.requestId,
    gitWriteLeaseExpiresAt: sql`${projectTasks.livenessDeadlineAt}`,
    updatedAt: input.now,
  }).where(and(
    eq(projectTasks.projectId, input.projectId),
    eq(projectTasks.livenessWorkerSessionId, input.workerSessionId),
    eq(projectTasks.status, 'doing'),
    gt(projectTasks.livenessDeadlineAt, input.now),
    noLiveTaskGitWrite(input.now),
  )).returning({
    taskId: projectTasks.taskId,
    requestId: projectTasks.gitWriteRequestId,
    leaseExpiresAt: projectTasks.gitWriteLeaseExpiresAt,
  });
  if (!admitted?.requestId || !admitted.leaseExpiresAt) return null;
  return {
    taskId: admitted.taskId,
    requestId: admitted.requestId,
    leaseExpiresAt: admitted.leaseExpiresAt,
  };
}

/** Clear only the matching receive-pack request. Late settlement is harmless. */
export async function settleProjectTaskGitWrite(
  database: Database,
  input: { projectId: string; workerSessionId: string; requestId: string; now: Date },
): Promise<boolean> {
  assertValidDate(input.now, 'now');
  const [settled] = await database.update(projectTasks).set({
    gitWriteRequestId: null,
    gitWriteLeaseExpiresAt: null,
    updatedAt: input.now,
  }).where(and(
    eq(projectTasks.projectId, input.projectId),
    eq(projectTasks.livenessWorkerSessionId, input.workerSessionId),
    eq(projectTasks.gitWriteRequestId, input.requestId),
  )).returning({ taskId: projectTasks.taskId });
  return Boolean(settled);
}

export const TASK_LIVENESS_ADMISSION_LEASE_POLICY = 'worker_deadline' as const;

export class TaskLivenessRequestInFlightError extends Error {
  readonly code = 'TASK_LIVENESS_REQUEST_IN_FLIGHT' as const;
  constructor(readonly taskId: string, readonly admissionExpiresAt: Date) {
    super(`task ${taskId} already has an in-flight gateway request until ${admissionExpiresAt.toISOString()}`);
    this.name = 'TaskLivenessRequestInFlightError';
  }
}

/**
 * Atomically acquire the durable request fence and increment iteration usage.
 * The fence expires at the immutable worker wall deadline. A gateway crash can
 * therefore delay the worker only until its bounded task must stop anyway.
 */
export async function admitProjectTaskWorkerIteration(
  database: Database,
  input: {
    workerSessionId: string;
    requestId: string;
    usage: ProjectTaskMeasuredUsage;
    now: Date;
  },
): Promise<{ taskId: string; admitted: true; admissionId: string; admissionExpiresAt: Date } | null> {
  const [row] = await database.select({ task: projectTasks, accountId: projects.accountId })
    .from(projectTasks)
    .innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
    .where(eq(projectTasks.livenessWorkerSessionId, input.workerSessionId))
    .limit(1);
  if (!row) return null;
  const active = row.task;
  if (active.status !== 'doing') throw new TaskLivenessLimitExceededError(active.taskId);
  if (
    active.livenessAdmissionId === input.requestId &&
    active.livenessAdmissionExpiresAt &&
    active.livenessAdmissionExpiresAt > input.now
  ) {
    return {
      taskId: active.taskId,
      admitted: true,
      admissionId: input.requestId,
      admissionExpiresAt: active.livenessAdmissionExpiresAt,
    };
  }
  const contract = active.livenessWorkerContract;
  if (!contract || !active.livenessDeadlineAt) {
    throw new TaskLivenessLimitExceededError(active.taskId);
  }
  const admissionExpiresAt = active.livenessDeadlineAt;
  const [admitted] = await database.update(projectTasks).set({
    livenessIterationsAdmitted: sql`${projectTasks.livenessIterationsAdmitted} + 1`,
    livenessAdmissionId: input.requestId,
    livenessAdmissionExpiresAt: admissionExpiresAt,
    updatedAt: input.now,
  }).where(and(
    eq(projectTasks.taskId, active.taskId),
    eq(projectTasks.status, 'doing'),
    gt(projectTasks.livenessDeadlineAt, input.now),
    or(
      isNull(projectTasks.livenessAdmissionId),
      lte(projectTasks.livenessAdmissionExpiresAt, input.now),
    ),
    sql`${projectTasks.livenessIterationsAdmitted} < (${projectTasks.livenessWorkerContract}->>'max_iterations')::integer`,
    sql`${input.usage.total_tokens} < (${projectTasks.livenessWorkerContract}->>'max_tokens')::numeric`,
    sql`${input.usage.total_cost} < (${projectTasks.livenessWorkerContract}->>'max_cost_usd')::numeric`,
  )).returning({ taskId: projectTasks.taskId });
  if (!admitted) {
    const fresh = await getProjectTask(database, { projectId: active.projectId, taskId: active.taskId });
    if (
      fresh?.status === 'doing' &&
      fresh.livenessAdmissionId === input.requestId &&
      fresh.livenessAdmissionExpiresAt &&
      fresh.livenessAdmissionExpiresAt > input.now
    ) {
      return {
        taskId: fresh.taskId,
        admitted: true,
        admissionId: input.requestId,
        admissionExpiresAt: fresh.livenessAdmissionExpiresAt,
      };
    }
    if (
      fresh?.status === 'doing' &&
      fresh.livenessAdmissionId &&
      fresh.livenessAdmissionExpiresAt &&
      fresh.livenessAdmissionExpiresAt > input.now
    ) {
      throw new TaskLivenessRequestInFlightError(active.taskId, fresh.livenessAdmissionExpiresAt);
    }
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
  return {
    taskId: admitted.taskId,
    admitted: true,
    admissionId: input.requestId,
    admissionExpiresAt,
  };
}

/** Fail closed when gateway accounting cannot durably settle this request. */
export async function blockProjectTaskWorkerAdmission(
  database: Database,
  input: { workerSessionId: string; admissionId: string; reason: string; now: Date },
): Promise<boolean> {
  const [row] = await database.select({ task: projectTasks, accountId: projects.accountId })
    .from(projectTasks)
    .innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
    .where(and(
      eq(projectTasks.livenessWorkerSessionId, input.workerSessionId),
      eq(projectTasks.livenessAdmissionId, input.admissionId),
      eq(projectTasks.status, 'doing'),
    ))
    .limit(1);
  if (!row) return false;
  return finalizeTaskLiveness(database, row.task, {
    accountId: row.accountId,
    reason: input.reason,
    now: input.now,
    expectedAdmissionId: input.admissionId,
  });
}

/**
 * Settle only the request that owns the durable fence. A late completion from
 * an expired/replaced request cannot clear a newer request's fence.
 */
export async function settleProjectTaskWorkerAdmission(
  database: Database,
  input: {
    workerSessionId: string;
    admissionId: string;
    usage: ProjectTaskMeasuredUsage;
    now: Date;
  },
): Promise<boolean> {
  const [row] = await database.select({ task: projectTasks, accountId: projects.accountId })
    .from(projectTasks)
    .innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
    .where(and(
      eq(projectTasks.livenessWorkerSessionId, input.workerSessionId),
      eq(projectTasks.livenessAdmissionId, input.admissionId),
      eq(projectTasks.status, 'doing'),
    ))
    .limit(1);
  if (!row) return false;

  const reason = exceededWorkerBounds(row.task, input.usage, input.now);
  if (reason) {
    return finalizeTaskLiveness(database, row.task, {
      accountId: row.accountId,
      reason,
      usage: input.usage,
      now: input.now,
      expectedAdmissionId: input.admissionId,
    });
  }

  const [released] = await database.update(projectTasks).set({
    livenessAdmissionId: null,
    livenessAdmissionExpiresAt: null,
    updatedAt: input.now,
  }).where(and(
    eq(projectTasks.taskId, row.task.taskId),
    eq(projectTasks.status, 'doing'),
    eq(projectTasks.livenessAdmissionId, input.admissionId),
  )).returning({ taskId: projectTasks.taskId });
  return Boolean(released);
}


async function finalizeTaskLiveness(
  database: Database,
  task: ProjectTask,
  input: {
    accountId: string;
    reason: string;
    usage?: ProjectTaskMeasuredUsage;
    now: Date;
    expectedAdmissionId?: string;
  },
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
      livenessAdmissionId: null,
      livenessAdmissionExpiresAt: null,
      gitWriteRequestId: null,
      gitWriteLeaseExpiresAt: null,
      updatedAt: input.now,
    }).where(and(
      eq(projectTasks.taskId, task.taskId),
      eq(projectTasks.status, 'doing'),
      ...(input.expectedAdmissionId
        ? [eq(projectTasks.livenessAdmissionId, input.expectedAdmissionId)]
        : []),
      noLiveTaskGitWrite(input.now),
    )).returning();
    if (!blocked) return false;
    await revokeWorkerSessionTokens(tx, task.livenessWorkerSessionId!, input.accountId, input.now);
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
          messageId: normalizeOpenCodeMessageId(`task-bound-escalate:${task.taskId}`),
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
    ))
    // Overdue wall bounds always lead the batch. Other active workers rotate by
    // their persisted last-swept cursor, so a recurring limited batch reaches
    // every row even when earlier rows remain healthy or their ledger read fails.
    .orderBy(
      asc(sql`case when ${projectTasks.livenessDeadlineAt} <= ${now.toISOString()}::timestamptz then 0 else 1 end`),
      asc(sql`coalesce(${projectTasks.livenessLastSweptAt}, ${projectTasks.livenessStartedAt})`),
      asc(projectTasks.taskId),
    )
    .limit(limit);
  let finalized = 0;
  for (const row of rows) {
    const workerSessionId = row.task.livenessWorkerSessionId;
    // The SQL predicate excludes NULL. Keep the runtime guard because the
    // database row type remains nullable and corrupted legacy rows must not abort the sweep.
    if (!workerSessionId) continue;
    try {
      const wallReason = row.task.livenessDeadlineAt && row.task.livenessDeadlineAt <= now
        ? 'max_wall_seconds exceeded'
        : null;
      const usage = !wallReason && loadUsage
        ? await loadUsage({ accountId: row.accountId, sessionId: workerSessionId })
        : undefined;
      const reason = wallReason ?? (usage ? exceededWorkerBounds(row.task, usage, now) : null);
      if (reason && await finalizeTaskLiveness(database, row.task, {
        accountId: row.accountId,
        reason,
        usage,
        now,
      })) finalized += 1;
    } catch (error) {
      console.error('[task-liveness] sweep row failed:', {
        taskId: row.task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        await database.update(projectTasks).set({ livenessLastSweptAt: now }).where(and(
          eq(projectTasks.taskId, row.task.taskId),
          eq(projectTasks.status, 'doing'),
        ));
      } catch (error) {
        console.error('[task-liveness] sweep cursor update failed:', {
          taskId: row.task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
