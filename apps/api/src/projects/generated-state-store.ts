import type { Database } from '@kortix/db';
import {
  projectGoalObservations,
  type projectTaskStatusEnum,
  projectTasks,
} from '@kortix/db/schema';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';

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
    super(`task ${taskId} in project ${projectId} has a live claim or does not exist`);
    this.name = 'TaskClaimConflictError';
    this.projectId = projectId;
    this.taskId = taskId;
  }
}

/**
 * Claim an unclaimed or expired task with one conditional UPDATE.
 *
 * The predicate and write execute in the same PostgreSQL statement. A live
 * claim never matches the predicate, so a contender cannot overwrite it.
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
      claimSessionId: input.sessionId,
      claimedAt: input.now,
      claimExpiresAt,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(projectTasks.projectId, input.projectId),
        eq(projectTasks.taskId, input.taskId),
        or(isNull(projectTasks.claimSessionId), lte(projectTasks.claimExpiresAt, input.now)),
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
  readonly claimSessionId: string;
  readonly claimExpiresAt: Date;

  constructor(input: {
    projectId: string;
    taskId: string;
    claimSessionId: string;
    claimExpiresAt: Date;
  }) {
    super(
      `task ${input.taskId} in project ${input.projectId} is claimed by session ${input.claimSessionId}`,
    );
    this.name = 'TaskTransitionConflictError';
    this.projectId = input.projectId;
    this.taskId = input.taskId;
    this.claimSessionId = input.claimSessionId;
    this.claimExpiresAt = input.claimExpiresAt;
  }
}

/**
 * Atomically change task status without overwriting another session's live claim.
 * Done and blocked transitions release the claim in the same UPDATE.
 */
export async function transitionProjectTask(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    status: ProjectTaskStatus;
    expectedClaimSessionId?: string | null;
    result?: Record<string, unknown>;
    now: Date;
  },
): Promise<ProjectTask | null> {
  assertValidDate(input.now, 'now');
  const clearsClaim = input.status === 'done' || input.status === 'blocked';
  const claimConditions = [
    isNull(projectTasks.claimSessionId),
    lte(projectTasks.claimExpiresAt, input.now),
  ];
  if (input.expectedClaimSessionId != null) {
    claimConditions.push(eq(projectTasks.claimSessionId, input.expectedClaimSessionId));
  }

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
        or(...claimConditions),
      ),
    )
    .returning();
  if (transitioned) return transitioned;

  const current = await getProjectTask(database, input);
  if (!current) return null;
  if (
    current.claimSessionId != null &&
    current.claimExpiresAt != null &&
    current.claimExpiresAt > input.now &&
    current.claimSessionId !== input.expectedClaimSessionId
  ) {
    throw new TaskTransitionConflictError({
      projectId: input.projectId,
      taskId: input.taskId,
      claimSessionId: current.claimSessionId,
      claimExpiresAt: current.claimExpiresAt,
    });
  }
  return null;
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
