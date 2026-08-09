import { randomUUID } from 'node:crypto';
import type { Database } from '@kortix/db';
import {
  accountTokens,
  projectTaskBlockers,
  projectTaskEvents,
  projectTaskEvidence,
  projectTaskMessages,
  projectTaskRefinementProposals,
  projectTaskSessionLinks,
  projectTasks,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db/schema';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { TASK_HARNESS_OVERRIDES_MAX_BYTES } from './generated-state-store';
import { normalizeOpenCodeMessageId } from './session-lifecycle/opencode-message-id';

export type TaskEvidence = typeof projectTaskEvidence.$inferSelect;
export type TaskBlocker = typeof projectTaskBlockers.$inferSelect;
export type TaskEvent = typeof projectTaskEvents.$inferSelect;
export type TaskMessage = typeof projectTaskMessages.$inferSelect;
export type TaskSessionLink = typeof projectTaskSessionLinks.$inferSelect;
export type TaskRefinementProposal = typeof projectTaskRefinementProposals.$inferSelect;
type TaskControlPlaneTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class TaskControlPlaneConflictError extends Error {
  readonly code = 'TASK_CONTROL_PLANE_CONFLICT' as const;
}

type TaskSideEffectFences = Pick<
  typeof projectTasks.$inferSelect,
  | 'livenessAdmissionId'
  | 'livenessAdmissionExpiresAt'
  | 'gitWriteRequestId'
  | 'gitWriteLeaseExpiresAt'
  | 'gitWriteState'
  | 'gitWriteRef'
  | 'gitWriteOldOid'
  | 'gitWriteNewOid'
>;

export function hasActiveTaskSideEffectFence(task: TaskSideEffectFences): boolean {
  return [
    task.livenessAdmissionId,
    task.livenessAdmissionExpiresAt,
    task.gitWriteRequestId,
    task.gitWriteLeaseExpiresAt,
    task.gitWriteState,
    task.gitWriteRef,
    task.gitWriteOldOid,
    task.gitWriteNewOid,
  ].some((value) => value !== null);
}

export const TASK_BLOCKER_REMINDER_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const TASK_BLOCKER_REMINDER_MIN_INTERVAL_MS = 15 * 60 * 1_000;
export const TASK_BLOCKER_REMINDER_MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export function taskBlockerReminderIntervalMs(target: Record<string, unknown>): number {
  const seconds = target.reminder_interval_seconds;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds)) {
    return TASK_BLOCKER_REMINDER_DEFAULT_INTERVAL_MS;
  }
  return Math.min(
    TASK_BLOCKER_REMINDER_MAX_INTERVAL_MS,
    Math.max(TASK_BLOCKER_REMINDER_MIN_INTERVAL_MS, seconds * 1_000),
  );
}

export function taskBlockerReminderText(
  blocker: Pick<
    TaskBlocker,
    'blockerId' | 'taskId' | 'category' | 'requestedAction' | 'target' | 'expiresAt'
  >,
): string {
  const action = blocker.requestedAction.slice(0, 8_000);
  const serializedTarget = JSON.stringify(blocker.target).slice(0, 4_000);
  return [
    `Task ${blocker.taskId} still has open blocker ${blocker.blockerId}.`,
    `Category: ${blocker.category}.`,
    `Required human action: ${action}`,
    `Target: ${serializedTarget}`,
    blocker.expiresAt ? `Deadline: ${blocker.expiresAt.toISOString()}.` : 'Deadline: none.',
    'Mirror this blocker through the existing review or channel path. Do not mark the task done.',
  ].join('\n');
}

async function reconcileBlockedTaskAfterFinalBlocker(
  tx: TaskControlPlaneTransaction,
  input: {
    projectId: string;
    taskId: string;
    blockerId: string;
    closure: 'resolved' | 'expired';
    now: Date;
  },
): Promise<{ requeued: boolean; coordinatorWoke: boolean }> {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(projectTaskBlockers)
    .where(
      and(
        eq(projectTaskBlockers.projectId, input.projectId),
        eq(projectTaskBlockers.taskId, input.taskId),
        eq(projectTaskBlockers.status, 'open'),
      ),
    );
  if ((count ?? 0) > 0) return { requeued: false, coordinatorWoke: false };

  const [requeued] = await tx
    .update(projectTasks)
    .set({
      status: 'todo',
      livenessWorkerSessionId: null,
      livenessCoordinatorSessionId: null,
      livenessWorkerContract: null,
      livenessStartedAt: null,
      livenessDeadlineAt: null,
      livenessIterationsAdmitted: 0,
      livenessTurnId: null,
      livenessAdmissionId: null,
      livenessAdmissionExpiresAt: null,
      gitWriteRequestId: null,
      gitWriteLeaseExpiresAt: null,
      gitWriteState: null,
      gitWriteRef: null,
      gitWriteOldOid: null,
      gitWriteNewOid: null,
      livenessLastSweptAt: null,
      noProgressSettlements: 0,
      continuationConsumedAt: null,
      lastProgressAt: null,
      lastProgressRef: null,
      lastNoProgressSettlementId: null,
      lastNoProgressAction: null,
      lastNoProgressCommandId: null,
      escalatedAt: null,
      livenessBlocker: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(projectTasks.projectId, input.projectId),
        eq(projectTasks.taskId, input.taskId),
        eq(projectTasks.status, 'blocked'),
      ),
    )
    .returning({ taskId: projectTasks.taskId });
  if (!requeued) return { requeued: false, coordinatorWoke: false };

  const [coordinator] = await tx
    .select({ sessionId: projectTaskSessionLinks.sessionId })
    .from(projectTaskSessionLinks)
    .where(
      and(
        eq(projectTaskSessionLinks.projectId, input.projectId),
        eq(projectTaskSessionLinks.taskId, input.taskId),
        eq(projectTaskSessionLinks.role, 'coordinator'),
      ),
    )
    .orderBy(desc(projectTaskSessionLinks.createdAt), asc(projectTaskSessionLinks.sessionId))
    .limit(1);
  if (!coordinator) return { requeued: true, coordinatorWoke: false };

  const [project] = await tx
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, input.projectId))
    .limit(1);
  if (!project) throw new Error(`project ${input.projectId} disappeared during blocker closure`);

  const idempotencyKey = `blocker-${input.closure}:${input.blockerId}`;
  await tx
    .insert(sessionLifecycleCommands)
    .values({
      commandType: 'continue_session',
      source: 'system:task-blocker-reminder',
      status: 'queued',
      projectId: input.projectId,
      accountId: project.accountId,
      sessionId: coordinator.sessionId,
      idempotencyKey,
      payload: {
        text: `Blocker ${input.blockerId} for task ${input.taskId} is ${input.closure}. No open blockers remain. Reclaim the task and continue from its current contract.`,
        messageId: normalizeOpenCodeMessageId(idempotencyKey),
      },
      result: {},
      availableAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
  return { requeued: true, coordinatorWoke: true };
}

export async function reviseProjectTaskContract(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    intent?: string;
    constraints?: string[];
    outOfScope?: string[];
    verificationRequirements?: Array<{
      id: string;
      kind: 'command' | 'http' | 'artifact' | 'deployment' | 'policy' | 'human' | 'monitor';
      description: string;
      required: boolean;
    }>;
    reviewPolicy?: { mode: 'auto' | 'human' };
    actorId: string | null;
    now: Date;
  },
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select task_id from ${projectTasks}
      where project_id = ${input.projectId} and task_id = ${input.taskId} for update`);
    const [task] = await tx
      .select()
      .from(projectTasks)
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
      )
      .limit(1)
      .for('update');
    if (!task) return null;
    if (task.status === 'review') {
      throw new TaskControlPlaneConflictError(
        'task contracts cannot change while completion is under review',
      );
    }
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new TaskControlPlaneConflictError(
        'completed and canceled task contracts are immutable',
      );
    }
    const nextRevision = task.contractRevision + 1;
    const [updated] = await tx
      .update(projectTasks)
      .set({
        contractRevision: nextRevision,
        ...(input.intent === undefined ? {} : { intent: input.intent }),
        ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
        ...(input.outOfScope === undefined ? {} : { outOfScope: input.outOfScope }),
        ...(input.verificationRequirements === undefined
          ? {}
          : { verificationRequirements: input.verificationRequirements }),
        ...(input.reviewPolicy === undefined ? {} : { reviewPolicy: input.reviewPolicy }),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(projectTasks.projectId, input.projectId),
          eq(projectTasks.taskId, input.taskId),
          eq(projectTasks.contractRevision, task.contractRevision),
        ),
      )
      .returning();
    if (!updated) throw new TaskControlPlaneConflictError('task contract changed concurrently');
    await tx.insert(projectTaskEvents).values({
      projectId: input.projectId,
      taskId: input.taskId,
      eventType: 'task.contract_revised',
      actorType: 'human',
      actorId: input.actorId,
      payload: {
        from_revision: task.contractRevision,
        to_revision: nextRevision,
      },
      createdAt: input.now,
    });
    return updated;
  });
}

export async function cancelProjectTask(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    actorId: string | null;
    reason: string;
    now: Date;
  },
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select task_id from ${projectTasks}
      where project_id = ${input.projectId} and task_id = ${input.taskId} for update`);
    const [current] = await tx
      .select({
        workerSessionId: projectTasks.livenessWorkerSessionId,
        livenessAdmissionId: projectTasks.livenessAdmissionId,
        livenessAdmissionExpiresAt: projectTasks.livenessAdmissionExpiresAt,
        gitWriteRequestId: projectTasks.gitWriteRequestId,
        gitWriteLeaseExpiresAt: projectTasks.gitWriteLeaseExpiresAt,
        gitWriteState: projectTasks.gitWriteState,
        gitWriteRef: projectTasks.gitWriteRef,
        gitWriteOldOid: projectTasks.gitWriteOldOid,
        gitWriteNewOid: projectTasks.gitWriteNewOid,
        accountId: projects.accountId,
      })
      .from(projectTasks)
      .innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
      )
      .limit(1);
    if (!current) return null;
    if (hasActiveTaskSideEffectFence(current)) {
      throw new TaskControlPlaneConflictError(
        'task cancellation requires settled admission and Git write fences',
      );
    }

    const [task] = await tx
      .update(projectTasks)
      .set({
        status: 'cancelled',
        claimSessionId: null,
        claimedAt: null,
        claimExpiresAt: null,
        livenessWorkerSessionId: null,
        livenessCoordinatorSessionId: null,
        livenessWorkerContract: null,
        livenessStartedAt: null,
        livenessDeadlineAt: null,
        livenessIterationsAdmitted: 0,
        livenessTurnId: null,
        livenessAdmissionId: null,
        livenessAdmissionExpiresAt: null,
        gitWriteRequestId: null,
        gitWriteLeaseExpiresAt: null,
        gitWriteState: null,
        gitWriteRef: null,
        gitWriteOldOid: null,
        gitWriteNewOid: null,
        updatedAt: input.now,
        result: sql`${projectTasks.result} || jsonb_build_object('canceled', jsonb_build_object('reason', ${input.reason}::text, 'at', ${input.now.toISOString()}::text, 'actor_id', ${input.actorId}::text))`,
      })
      .where(
        and(
          eq(projectTasks.projectId, input.projectId),
          eq(projectTasks.taskId, input.taskId),
          inArray(projectTasks.status, ['backlog', 'todo', 'doing', 'blocked', 'review']),
        ),
      )
      .returning();
    if (!task) return null;

    if (current.workerSessionId) {
      await tx
        .update(accountTokens)
        .set({ status: 'revoked', revokedAt: input.now })
        .where(
          and(
            eq(accountTokens.sessionId, current.workerSessionId),
            eq(accountTokens.accountId, current.accountId),
            eq(accountTokens.status, 'active'),
          ),
        );
      await tx
        .insert(sessionLifecycleCommands)
        .values({
          commandType: 'stop_session',
          source: 'system:task-cancellation',
          status: 'queued',
          projectId: input.projectId,
          accountId: current.accountId,
          sessionId: current.workerSessionId,
          idempotencyKey: `task-cancel-stop:${input.taskId}:${current.workerSessionId}`,
          payload: { reason: 'task_cancelled' },
          result: {},
          availableAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: sessionLifecycleCommands.idempotencyKey,
        });
    }
    await tx.insert(projectTaskEvents).values({
      projectId: input.projectId,
      taskId: input.taskId,
      eventType: 'task.canceled',
      actorType: 'human',
      actorId: input.actorId,
      payload: {
        reason: input.reason,
        worker_session_id: current.workerSessionId,
        authority_revoked: current.workerSessionId !== null,
      },
      createdAt: input.now,
    });
    return task;
  });
}

/** Recover expired coordinator-only claims through the existing scheduler. */
export async function sweepExpiredProjectTaskCoordinatorClaims(
  database: Database,
  now: Date,
  limit = 100,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('limit must be an integer between 1 and 1000');
  }
  return database.transaction(async (tx) => {
    const expired = await tx
      .select({ task: projectTasks, accountId: projects.accountId })
      .from(projectTasks)
      .innerJoin(projects, eq(projects.projectId, projectTasks.projectId))
      .where(
        and(
          eq(projectTasks.status, 'doing'),
          lte(projectTasks.claimExpiresAt, now),
          isNull(projectTasks.livenessWorkerSessionId),
        ),
      )
      .orderBy(asc(projectTasks.claimExpiresAt), asc(projectTasks.taskId))
      .limit(limit)
      .for('update', { skipLocked: true });

    let recovered = 0;
    for (const row of expired) {
      const coordinatorSessionId = row.task.claimSessionId;
      const expiredAt = row.task.claimExpiresAt;
      if (!coordinatorSessionId || !expiredAt) continue;
      const [task] = await tx
        .update(projectTasks)
        .set({
          status: 'todo',
          claimSessionId: null,
          claimedAt: null,
          claimExpiresAt: null,
          livenessTurnId: null,
          livenessAdmissionId: null,
          livenessAdmissionExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(projectTasks.taskId, row.task.taskId),
            eq(projectTasks.status, 'doing'),
            eq(projectTasks.claimSessionId, coordinatorSessionId),
            eq(projectTasks.claimExpiresAt, expiredAt),
            isNull(projectTasks.livenessWorkerSessionId),
          ),
        )
        .returning({ taskId: projectTasks.taskId });
      if (!task) continue;
      const idempotencyKey = `task-coordinator-recover:${task.taskId}:${coordinatorSessionId}:${expiredAt.toISOString()}`;
      await tx
        .insert(sessionLifecycleCommands)
        .values({
          commandType: 'continue_session',
          source: 'system:task-coordinator-recovery',
          status: 'queued',
          projectId: row.task.projectId,
          accountId: row.accountId,
          sessionId: coordinatorSessionId,
          idempotencyKey,
          payload: {
            text: `Task ${task.taskId} claim expired and returned to todo. Reclaim it if you can continue, or leave it for another coordinator.`,
            messageId: normalizeOpenCodeMessageId(idempotencyKey),
          },
          result: {},
          availableAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: sessionLifecycleCommands.idempotencyKey,
        });
      await tx.insert(projectTaskEvents).values({
        projectId: row.task.projectId,
        taskId: task.taskId,
        eventType: 'task.coordinator_recovered',
        actorType: 'system',
        sessionId: coordinatorSessionId,
        payload: {
          coordinator_session_id: coordinatorSessionId,
          claim_expired_at: expiredAt.toISOString(),
          recovered_at: now.toISOString(),
        },
        createdAt: now,
      });
      recovered += 1;
    }
    return recovered;
  });
}

export async function currentProjectTaskForSession(
  database: Database,
  input: { projectId: string; sessionId: string },
) {
  const [task] = await database
    .select({ task: projectTasks })
    .from(projectTasks)
    .where(
      and(
        eq(projectTasks.projectId, input.projectId),
        or(
          eq(projectTasks.claimSessionId, input.sessionId),
          eq(projectTasks.livenessWorkerSessionId, input.sessionId),
          sql`exists (
            select 1 from ${projectTaskSessionLinks} lineage
            where lineage.project_id = ${projectTasks.projectId}
              and lineage.task_id = ${projectTasks.taskId}
              and lineage.session_id = ${input.sessionId}
          )`,
        ),
      ),
    )
    .orderBy(
      sql`case
        when ${projectTasks.claimSessionId} = ${input.sessionId}
          and ${projectTasks.status} in ('doing', 'review') then 0
        when ${projectTasks.livenessWorkerSessionId} = ${input.sessionId}
          and ${projectTasks.status} = 'doing' then 1
        else 2
      end`,
      desc(projectTasks.updatedAt),
      asc(projectTasks.taskId),
    )
    .limit(1);
  return task?.task ?? null;
}

export async function appendProjectTaskEvent(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    eventType: string;
    actorType: string;
    actorId?: string | null;
    sessionId?: string | null;
    payload?: Record<string, unknown>;
    now?: Date;
  },
) {
  const [event] = await database
    .insert(projectTaskEvents)
    .values({
      projectId: input.projectId,
      taskId: input.taskId,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      payload: input.payload ?? {},
      createdAt: input.now ?? new Date(),
    })
    .returning();
  if (!event) throw new Error('task event insert returned no row');
  return event;
}

export async function listProjectTaskEvents(
  database: Database,
  input: { projectId: string; taskId: string; limit?: number },
) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1_000);
  return database
    .select()
    .from(projectTaskEvents)
    .where(
      and(
        eq(projectTaskEvents.projectId, input.projectId),
        eq(projectTaskEvents.taskId, input.taskId),
      ),
    )
    .orderBy(asc(projectTaskEvents.createdAt), asc(projectTaskEvents.eventId))
    .limit(limit);
}

export async function addProjectTaskEvidence(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    sessionId: string | null;
    requirementId: string | null;
    kind: string;
    ref: string;
    summary?: string;
    candidateDigest: string;
    state: 'passed' | 'failed' | 'info';
    now: Date;
  },
) {
  return database.transaction(async (tx) => {
    const [task] = await tx
      .select({ contractRevision: projectTasks.contractRevision })
      .from(projectTasks)
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
      )
      .limit(1);
    if (!task) return null;
    const [evidence] = await tx
      .insert(projectTaskEvidence)
      .values({
        projectId: input.projectId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        contractRevision: task.contractRevision,
        requirementId: input.requirementId,
        kind: input.kind,
        ref: input.ref,
        summary: input.summary ?? '',
        candidateDigest: input.candidateDigest,
        state: input.state,
        createdAt: input.now,
      })
      .returning();
    if (!evidence) throw new Error('task evidence insert returned no row');
    await tx.insert(projectTaskEvents).values({
      projectId: input.projectId,
      taskId: input.taskId,
      eventType: 'task.evidence_added',
      actorType: input.sessionId ? 'session' : 'human',
      actorId: input.sessionId,
      sessionId: input.sessionId,
      payload: {
        evidence_id: evidence.evidenceId,
        requirement_id: evidence.requirementId,
        candidate_digest: evidence.candidateDigest,
        state: evidence.state,
      },
      createdAt: input.now,
    });
    return evidence;
  });
}

export async function listProjectTaskEvidence(
  database: Database,
  input: { projectId: string; taskId: string },
) {
  return database
    .select()
    .from(projectTaskEvidence)
    .where(
      and(
        eq(projectTaskEvidence.projectId, input.projectId),
        eq(projectTaskEvidence.taskId, input.taskId),
      ),
    )
    .orderBy(asc(projectTaskEvidence.createdAt), asc(projectTaskEvidence.evidenceId));
}

export async function createProjectTaskBlocker(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    category: string;
    requestedAction: string;
    target: Record<string, unknown>;
    requestDigest: string;
    attemptsMade: string[];
    nextReminderAt: Date | null | undefined;
    expiresAt: Date | null;
    sessionId: string | null;
    now: Date;
  },
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select task_id from ${projectTasks}
      where project_id = ${input.projectId} and task_id = ${input.taskId} for update`);
    const [task] = await tx
      .select({ status: projectTasks.status })
      .from(projectTasks)
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
      )
      .limit(1);
    if (!task) throw new TaskControlPlaneConflictError('task not found');
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new TaskControlPlaneConflictError('terminal tasks cannot acquire blockers');
    }
    const [blocker] = await tx
      .insert(projectTaskBlockers)
      .values({
        projectId: input.projectId,
        taskId: input.taskId,
        category: input.category,
        requestedAction: input.requestedAction,
        target: input.target,
        requestDigest: input.requestDigest,
        attemptsMade: input.attemptsMade,
        nextReminderAt:
          input.nextReminderAt === undefined
            ? new Date(input.now.getTime() + TASK_BLOCKER_REMINDER_DEFAULT_INTERVAL_MS)
            : input.nextReminderAt,
        expiresAt: input.expiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (!blocker) {
      const [existing] = await tx
        .select()
        .from(projectTaskBlockers)
        .where(
          and(
            eq(projectTaskBlockers.projectId, input.projectId),
            eq(projectTaskBlockers.taskId, input.taskId),
            eq(projectTaskBlockers.requestDigest, input.requestDigest),
            eq(projectTaskBlockers.status, 'open'),
          ),
        )
        .limit(1);
      if (!existing) throw new Error('task blocker conflict did not expose an open blocker');
      return { blocker: existing, created: false };
    }
    await tx.insert(projectTaskEvents).values({
      projectId: input.projectId,
      taskId: input.taskId,
      eventType: 'task.blocker_created',
      actorType: input.sessionId ? 'session' : 'human',
      actorId: input.sessionId,
      sessionId: input.sessionId,
      payload: {
        blocker_id: blocker.blockerId,
        category: blocker.category,
        next_reminder_at: blocker.nextReminderAt?.toISOString() ?? null,
      },
      createdAt: input.now,
    });
    return { blocker, created: true };
  });
}

export async function listProjectTaskBlockers(
  database: Database,
  input: { projectId: string; taskId: string; status?: string },
) {
  return database
    .select()
    .from(projectTaskBlockers)
    .where(
      and(
        eq(projectTaskBlockers.projectId, input.projectId),
        eq(projectTaskBlockers.taskId, input.taskId),
        ...(input.status ? [eq(projectTaskBlockers.status, input.status)] : []),
      ),
    )
    .orderBy(desc(projectTaskBlockers.createdAt));
}

/**
 * Claim due blocker reminders inside the existing trigger-scheduler sweep.
 *
 * Each claim advances `next_reminder_at`, writes the canonical Review Center
 * message and timeline event, and queues the coordinator wake through the
 * existing session lifecycle outbox. Row locks and deterministic keys make a
 * concurrent leader handoff safe.
 */
export async function sweepDueProjectTaskBlockerReminders(
  database: Database,
  now: Date,
  limit = 100,
): Promise<{ reminded: number; expired: number; coordinatorWakes: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('limit must be an integer between 1 and 1000');
  }
  return database.transaction(async (tx) => {
    const dueCandidates = await tx
      .select()
      .from(projectTaskBlockers)
      .where(
        and(
          eq(projectTaskBlockers.status, 'open'),
          or(lte(projectTaskBlockers.nextReminderAt, now), lte(projectTaskBlockers.expiresAt, now)),
        ),
      )
      .orderBy(
        asc(projectTaskBlockers.expiresAt),
        asc(projectTaskBlockers.nextReminderAt),
        asc(projectTaskBlockers.blockerId),
      )
      .limit(limit);

    let reminded = 0;
    let expired = 0;
    let coordinatorWakes = 0;
    for (const candidate of dueCandidates) {
      const [lockedTask] = await tx
        .select({ taskId: projectTasks.taskId })
        .from(projectTasks)
        .where(
          and(
            eq(projectTasks.projectId, candidate.projectId),
            eq(projectTasks.taskId, candidate.taskId),
          ),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!lockedTask) continue;

      const [blocker] = await tx
        .select()
        .from(projectTaskBlockers)
        .where(
          and(
            eq(projectTaskBlockers.blockerId, candidate.blockerId),
            eq(projectTaskBlockers.status, 'open'),
            or(
              lte(projectTaskBlockers.nextReminderAt, now),
              lte(projectTaskBlockers.expiresAt, now),
            ),
          ),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!blocker) continue;

      if (blocker.expiresAt && blocker.expiresAt <= now) {
        await tx
          .update(projectTaskBlockers)
          .set({ status: 'expired', nextReminderAt: null, updatedAt: now })
          .where(
            and(
              eq(projectTaskBlockers.blockerId, blocker.blockerId),
              eq(projectTaskBlockers.status, 'open'),
            ),
          );
        await tx.insert(projectTaskEvents).values({
          projectId: blocker.projectId,
          taskId: blocker.taskId,
          eventType: 'task.blocker_expired',
          actorType: 'system',
          payload: {
            blocker_id: blocker.blockerId,
            expired_at: now.toISOString(),
          },
          createdAt: now,
        });
        const reconciled = await reconcileBlockedTaskAfterFinalBlocker(tx, {
          projectId: blocker.projectId,
          taskId: blocker.taskId,
          blockerId: blocker.blockerId,
          closure: 'expired',
          now,
        });
        expired += 1;
        if (reconciled.coordinatorWoke) coordinatorWakes += 1;
        continue;
      }
      const scheduledFor = blocker.nextReminderAt;
      if (!scheduledFor) continue;

      const idempotencyKey = `blocker-reminder:${blocker.blockerId}:${scheduledFor.toISOString()}`;
      const [coordinator] = await tx
        .select({ sessionId: projectTaskSessionLinks.sessionId })
        .from(projectTaskSessionLinks)
        .where(
          and(
            eq(projectTaskSessionLinks.projectId, blocker.projectId),
            eq(projectTaskSessionLinks.taskId, blocker.taskId),
            eq(projectTaskSessionLinks.role, 'coordinator'),
          ),
        )
        .orderBy(desc(projectTaskSessionLinks.createdAt), asc(projectTaskSessionLinks.sessionId))
        .limit(1);
      const [project] = await tx
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, blocker.projectId))
        .limit(1);
      if (!project) throw new Error(`project ${blocker.projectId} disappeared during reminder`);

      await tx
        .insert(projectTaskMessages)
        .values({
          projectId: blocker.projectId,
          taskId: blocker.taskId,
          senderSessionId: null,
          recipientSessionId: coordinator?.sessionId ?? null,
          messageType: 'blocker_reminder',
          body: {
            blocker_id: blocker.blockerId,
            category: blocker.category,
            requested_action: blocker.requestedAction,
            target: blocker.target,
            scheduled_for: scheduledFor.toISOString(),
            expires_at: blocker.expiresAt?.toISOString() ?? null,
          },
          correlationId: blocker.blockerId,
          idempotencyKey,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [projectTaskMessages.taskId, projectTaskMessages.idempotencyKey],
        });
      await tx.insert(projectTaskEvents).values({
        projectId: blocker.projectId,
        taskId: blocker.taskId,
        eventType: 'task.blocker_reminder_queued',
        actorType: 'system',
        sessionId: coordinator?.sessionId ?? null,
        payload: {
          blocker_id: blocker.blockerId,
          scheduled_for: scheduledFor.toISOString(),
          coordinator_session_id: coordinator?.sessionId ?? null,
        },
        createdAt: now,
      });

      if (coordinator) {
        await tx
          .insert(sessionLifecycleCommands)
          .values({
            commandType: 'continue_session',
            source: 'system:task-blocker-reminder',
            status: 'queued',
            projectId: blocker.projectId,
            accountId: project.accountId,
            sessionId: coordinator.sessionId,
            idempotencyKey,
            payload: {
              text: taskBlockerReminderText(blocker),
              messageId: normalizeOpenCodeMessageId(idempotencyKey),
            },
            result: {},
            availableAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: sessionLifecycleCommands.idempotencyKey,
          });
        coordinatorWakes += 1;
      }
      await tx
        .update(projectTaskBlockers)
        .set({
          nextReminderAt: new Date(now.getTime() + taskBlockerReminderIntervalMs(blocker.target)),
          updatedAt: now,
        })
        .where(
          and(
            eq(projectTaskBlockers.blockerId, blocker.blockerId),
            eq(projectTaskBlockers.status, 'open'),
          ),
        );
      reminded += 1;
    }
    return { reminded, expired, coordinatorWakes };
  });
}

export async function resolveProjectTaskBlocker(
  database: Database,
  input: { projectId: string; taskId: string; blockerId: string; now: Date },
) {
  return database.transaction(async (tx) => {
    const [task] = await tx
      .select({ taskId: projectTasks.taskId })
      .from(projectTasks)
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
      )
      .limit(1)
      .for('update');
    if (!task) return null;

    const [blocker] = await tx
      .update(projectTaskBlockers)
      .set({ status: 'resolved', resolvedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(projectTaskBlockers.projectId, input.projectId),
          eq(projectTaskBlockers.taskId, input.taskId),
          eq(projectTaskBlockers.blockerId, input.blockerId),
          eq(projectTaskBlockers.status, 'open'),
        ),
      )
      .returning();
    if (!blocker) return null;
    await tx.insert(projectTaskEvents).values({
      projectId: input.projectId,
      taskId: input.taskId,
      eventType: 'task.blocker_resolved',
      actorType: 'human',
      payload: { blocker_id: blocker.blockerId },
      createdAt: input.now,
    });
    await reconcileBlockedTaskAfterFinalBlocker(tx, {
      projectId: input.projectId,
      taskId: input.taskId,
      blockerId: blocker.blockerId,
      closure: 'resolved',
      now: input.now,
    });
    return blocker;
  });
}

export async function listProjectTaskSessionLinks(
  database: Database,
  input: { projectId: string; taskId: string },
) {
  return database
    .select()
    .from(projectTaskSessionLinks)
    .where(
      and(
        eq(projectTaskSessionLinks.projectId, input.projectId),
        eq(projectTaskSessionLinks.taskId, input.taskId),
      ),
    )
    .orderBy(asc(projectTaskSessionLinks.createdAt));
}

export async function sendProjectTaskMessage(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    senderSessionId: string | null;
    recipientSessionId: string | null;
    messageType: string;
    body: Record<string, unknown>;
    correlationId: string | null;
    idempotencyKey: string;
    now: Date;
  },
) {
  return database.transaction(async (tx) => {
    const sessionIds = [input.senderSessionId, input.recipientSessionId].filter(
      (value): value is string => value !== null,
    );
    if (sessionIds.length > 0) {
      const links = await tx
        .select({ sessionId: projectTaskSessionLinks.sessionId })
        .from(projectTaskSessionLinks)
        .where(
          and(
            eq(projectTaskSessionLinks.projectId, input.projectId),
            eq(projectTaskSessionLinks.taskId, input.taskId),
            inArray(projectTaskSessionLinks.sessionId, sessionIds),
          ),
        );
      if (new Set(links.map((link) => link.sessionId)).size !== new Set(sessionIds).size) {
        throw new TaskControlPlaneConflictError('message sessions are outside the task lineage');
      }
    }
    const [inserted] = await tx
      .insert(projectTaskMessages)
      .values({
        projectId: input.projectId,
        taskId: input.taskId,
        senderSessionId: input.senderSessionId,
        recipientSessionId: input.recipientSessionId,
        messageType: input.messageType,
        body: input.body,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        status: 'queued',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { message: inserted, created: true };
    const [existing] = await tx
      .select()
      .from(projectTaskMessages)
      .where(
        and(
          eq(projectTaskMessages.taskId, input.taskId),
          eq(projectTaskMessages.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('task message conflicted but could not be loaded');
    return { message: existing, created: false };
  });
}

export async function listProjectTaskMessages(
  database: Database,
  input: { projectId: string; taskId: string; recipientSessionId?: string },
) {
  return database
    .select()
    .from(projectTaskMessages)
    .where(
      and(
        eq(projectTaskMessages.projectId, input.projectId),
        eq(projectTaskMessages.taskId, input.taskId),
        ...(input.recipientSessionId
          ? [eq(projectTaskMessages.recipientSessionId, input.recipientSessionId)]
          : []),
      ),
    )
    .orderBy(asc(projectTaskMessages.createdAt));
}

export async function acknowledgeProjectTaskMessage(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    messageId: string;
    recipientSessionId: string;
    now: Date;
  },
) {
  const [message] = await database
    .update(projectTaskMessages)
    .set({
      status: 'processed',
      acknowledgedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(projectTaskMessages.projectId, input.projectId),
        eq(projectTaskMessages.taskId, input.taskId),
        eq(projectTaskMessages.messageId, input.messageId),
        eq(projectTaskMessages.recipientSessionId, input.recipientSessionId),
      ),
    )
    .returning();
  return message ?? null;
}

export async function proposeProjectTaskRefinement(
  database: Database,
  input: {
    projectId: string;
    taskId: string | null;
    scope: 'task' | 'agent' | 'project' | 'account' | 'platform';
    observation: string;
    baseRevision: string;
    patch: Record<string, unknown>;
    evidenceRefs: string[];
    sessionId: string | null;
    now: Date;
  },
) {
  if (input.scope === 'task') {
    const patchBytes = new TextEncoder().encode(JSON.stringify(input.patch)).byteLength;
    if (patchBytes > TASK_HARNESS_OVERRIDES_MAX_BYTES) {
      throw new TaskControlPlaneConflictError(
        `task harness overrides exceed ${TASK_HARNESS_OVERRIDES_MAX_BYTES} UTF-8 bytes`,
      );
    }
  }
  return database.transaction(async (tx) => {
    const proposalId = randomUUID();
    let rollbackPatch: Record<string, unknown> = {};
    let status = 'proposed';
    if (input.scope === 'task') {
      if (!input.taskId) throw new TaskControlPlaneConflictError('task scope requires task_id');
      const [task] = await tx
        .select({ result: projectTasks.result })
        .from(projectTasks)
        .where(
          and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
        )
        .limit(1)
        .for('update');
      if (!task) throw new TaskControlPlaneConflictError('task not found');
      const currentRevision =
        typeof task.result.harness_revision === 'string' ? task.result.harness_revision : '0';
      if (input.baseRevision !== currentRevision) {
        throw new TaskControlPlaneConflictError(
          `task harness revision conflict: expected ${currentRevision}`,
        );
      }
      rollbackPatch =
        task.result.harness_overrides && typeof task.result.harness_overrides === 'object'
          ? (task.result.harness_overrides as Record<string, unknown>)
          : {};
      await tx
        .update(projectTasks)
        .set({
          result: {
            ...task.result,
            harness_overrides: input.patch,
            harness_revision: proposalId,
          },
          updatedAt: input.now,
        })
        .where(
          and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
        );
      status = 'applied';
    }
    const [proposal] = await tx
      .insert(projectTaskRefinementProposals)
      .values({
        proposalId,
        projectId: input.projectId,
        taskId: input.taskId,
        scope: input.scope,
        observation: input.observation,
        baseRevision: input.baseRevision,
        patch: input.patch,
        rollbackPatch,
        evidenceRefs: input.evidenceRefs,
        status,
        createdBySessionId: input.sessionId,
        appliedAt: status === 'applied' ? input.now : null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    if (!proposal) throw new Error('refinement proposal insert returned no row');
    return proposal;
  });
}

export async function listProjectTaskRefinements(database: Database, projectId: string) {
  return database
    .select()
    .from(projectTaskRefinementProposals)
    .where(eq(projectTaskRefinementProposals.projectId, projectId))
    .orderBy(desc(projectTaskRefinementProposals.createdAt));
}

export async function rollbackProjectTaskRefinement(
  database: Database,
  input: { projectId: string; proposalId: string; now: Date },
) {
  return database.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(projectTaskRefinementProposals)
      .where(
        and(
          eq(projectTaskRefinementProposals.projectId, input.projectId),
          eq(projectTaskRefinementProposals.proposalId, input.proposalId),
          eq(projectTaskRefinementProposals.status, 'applied'),
        ),
      )
      .limit(1);
    if (!proposal || proposal.scope !== 'task' || !proposal.taskId) return null;
    const [task] = await tx
      .select({ result: projectTasks.result })
      .from(projectTasks)
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, proposal.taskId)),
      )
      .limit(1)
      .for('update');
    if (!task) return null;
    const currentRevision =
      typeof task.result.harness_revision === 'string' ? task.result.harness_revision : '0';
    if (currentRevision !== proposal.proposalId) {
      throw new TaskControlPlaneConflictError(
        `task harness rollback conflict: current revision is ${currentRevision}`,
      );
    }
    await tx
      .update(projectTasks)
      .set({
        result: {
          ...task.result,
          harness_overrides: proposal.rollbackPatch,
          harness_revision: proposal.baseRevision,
        },
        updatedAt: input.now,
      })
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, proposal.taskId)),
      );
    const [rolledBack] = await tx
      .update(projectTaskRefinementProposals)
      .set({
        status: 'rolled_back',
        rolledBackAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(projectTaskRefinementProposals.proposalId, input.proposalId))
      .returning();
    return rolledBack ?? null;
  });
}
