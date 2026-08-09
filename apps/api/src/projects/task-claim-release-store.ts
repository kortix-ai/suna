import type { Database } from '@kortix/db';
import { projectTaskEvents, projectTasks } from '@kortix/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

export type TaskClaimReleaseStoreResult =
  | {
      state: 'released' | 'already_released';
      task: typeof projectTasks.$inferSelect;
      released: boolean;
    }
  | { state: 'not_found' }
  | { state: 'conflict' };

/**
 * Release an unused coordinator claim after launch compensation.
 *
 * The conditional update refuses to unwind a task after worker admission or a
 * Git write starts. Repeating a successful release returns the unclaimed todo
 * row without adding another event.
 */
export async function releaseProjectTaskClaimForCompensation(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    sessionId: string;
    now: Date;
  },
): Promise<TaskClaimReleaseStoreResult> {
  return database.transaction(async (tx) => {
    const [released] = await tx
      .update(projectTasks)
      .set({
        status: 'todo',
        claimSessionId: null,
        claimedAt: null,
        claimExpiresAt: null,
        livenessTurnId: null,
        livenessAdmissionId: null,
        livenessAdmissionExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(projectTasks.projectId, input.projectId),
          eq(projectTasks.taskId, input.taskId),
          eq(projectTasks.status, 'doing'),
          eq(projectTasks.claimSessionId, input.sessionId),
          isNull(projectTasks.livenessWorkerSessionId),
          isNull(projectTasks.livenessAdmissionId),
          isNull(projectTasks.gitWriteRequestId),
        ),
      )
      .returning();

    if (released) {
      await tx.insert(projectTaskEvents).values({
        projectId: input.projectId,
        taskId: input.taskId,
        eventType: 'task.claim_released',
        actorType: 'session',
        actorId: input.sessionId,
        sessionId: input.sessionId,
        payload: { reason: 'coordinator_launch_compensation' },
        createdAt: input.now,
      });
      return { state: 'released', task: released, released: true };
    }

    const [current] = await tx
      .select()
      .from(projectTasks)
      .where(
        and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
      )
      .limit(1);
    if (!current) return { state: 'not_found' };
    if (current.status === 'todo' && current.claimSessionId === null) {
      return { state: 'already_released', task: current, released: false };
    }
    return { state: 'conflict' };
  });
}
