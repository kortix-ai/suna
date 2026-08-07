import { projectTriggerExecutions, projectTriggerRuntime, projects } from '@kortix/db';
import { and, asc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { nextTriggerScheduleSlot } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

export type TriggerExecutionRow = typeof projectTriggerExecutions.$inferSelect;

export interface ClaimedScheduleSlot {
  execution: TriggerExecutionRow;
  inserted: boolean;
}

async function mapConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()),
  );
  return results;
}

function triggerPayload(input: {
  spec: GitTriggerSpec;
  scheduledFor: Date;
  claimedAt: Date;
  lastScheduledFor: Date | null;
}) {
  return {
    cron: {
      schedule: input.spec.cron ?? input.spec.runAt,
      timezone: input.spec.timezone,
      scheduled_for: input.scheduledFor.toISOString(),
      claimed_at: input.claimedAt.toISOString(),
      last_scheduled_for: input.lastScheduledFor?.toISOString() ?? null,
    },
    trigger: { slug: input.spec.slug, type: input.spec.type, kind: 'git' },
    ...(input.spec.goalSlug ? { goal: { slug: input.spec.goalSlug } } : {}),
  };
}

/**
 * Atomically materialize due schedule slots.
 *
 * The execution insert and `next_fire_at` advance share one transaction. A
 * crash cannot lose a slot between those two writes. The unique slot index
 * plus the compare-and-swap update make concurrent scheduler pods safe.
 */
export async function claimDueScheduleSlots(input: {
  now: Date;
  limit: number;
}): Promise<ClaimedScheduleSlot[]> {
  const candidates = await db
    .select({
      projectId: projectTriggerRuntime.projectId,
      slug: projectTriggerRuntime.slug,
      scheduleRevision: projectTriggerRuntime.scheduleRevision,
      nextFireAt: projectTriggerRuntime.nextFireAt,
      lastScheduledFor: projectTriggerRuntime.lastScheduledFor,
      scheduleSpec: projectTriggerRuntime.scheduleSpec,
    })
    .from(projectTriggerRuntime)
    .innerJoin(projects, eq(projects.projectId, projectTriggerRuntime.projectId))
    .where(
      and(
        eq(projects.status, 'active'),
        eq(projectTriggerRuntime.enabled, true),
        eq(projectTriggerRuntime.triggerType, 'cron'),
        lte(projectTriggerRuntime.nextFireAt, input.now),
        sql`coalesce(${projects.metadata} ->> 'triggers_paused', 'false') <> 'true'`,
      ),
    )
    .orderBy(asc(projectTriggerRuntime.nextFireAt), asc(projectTriggerRuntime.projectId))
    .limit(input.limit);

  const results = await mapConcurrently(candidates, 8, async (candidate) => {
    if (!candidate.nextFireAt || !candidate.scheduleRevision || !candidate.scheduleSpec) {
      return null;
    }
    const scheduleRevision = candidate.scheduleRevision;
    const scheduleSpec = candidate.scheduleSpec;
    const spec = scheduleSpec as unknown as GitTriggerSpec;
    const scheduledFor = candidate.nextFireAt;
    // Coalesce missed recurring slots into one execution. After downtime, one
    // catch-up run is queued and the catalog advances to the first future slot.
    // This prevents a restart from producing an unbounded execution storm.
    const nextFireAt = spec.runAt ? null : nextTriggerScheduleSlot(spec, input.now);
    return db.transaction(async (tx) => {
      // Advance first. If the manifest was reconciled or another scheduler
      // claimed this slot after candidate selection, the CAS fails and no
      // stale execution row is inserted.
      const advanced = await tx
        .update(projectTriggerRuntime)
        .set({
          nextFireAt,
          lastScheduledFor: scheduledFor,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(projectTriggerRuntime.projectId, candidate.projectId),
            eq(projectTriggerRuntime.slug, candidate.slug),
            eq(projectTriggerRuntime.scheduleRevision, scheduleRevision),
            eq(projectTriggerRuntime.nextFireAt, scheduledFor),
          ),
        )
        .returning({ projectId: projectTriggerRuntime.projectId });

      if (!advanced[0]) return null;

      const inserted = await tx
        .insert(projectTriggerExecutions)
        .values({
          projectId: candidate.projectId,
          slug: candidate.slug,
          scheduleRevision,
          scheduledFor,
          status: 'queued',
          spec: scheduleSpec,
          payload: triggerPayload({
            spec,
            scheduledFor,
            claimedAt: input.now,
            lastScheduledFor: candidate.lastScheduledFor,
          }),
          availableAt: input.now,
          claimedAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: [
            projectTriggerExecutions.projectId,
            projectTriggerExecutions.slug,
            projectTriggerExecutions.scheduleRevision,
            projectTriggerExecutions.scheduledFor,
          ],
        })
        .returning();

      if (inserted[0]) return { execution: inserted[0], inserted: true };

      const [existing] = await tx
        .select()
        .from(projectTriggerExecutions)
        .where(
          and(
            eq(projectTriggerExecutions.projectId, candidate.projectId),
            eq(projectTriggerExecutions.slug, candidate.slug),
            eq(projectTriggerExecutions.scheduleRevision, scheduleRevision),
            eq(projectTriggerExecutions.scheduledFor, scheduledFor),
          ),
        )
        .limit(1);
      return existing ? { execution: existing, inserted: false } : null;
    });
  });
  return results.filter((result): result is ClaimedScheduleSlot => result !== null);
}

export async function claimTriggerExecutions(input: {
  now: Date;
  workerId: string;
  limit: number;
  leaseMs?: number;
}): Promise<TriggerExecutionRow[]> {
  const leaseMs = input.leaseMs ?? 2 * 60_000;
  // A worker may die during its final attempt. Once that lease expires, make
  // the abandonment explicit instead of leaving a permanent `running` row.
  await db
    .update(projectTriggerExecutions)
    .set({
      status: 'dead_lettered',
      lockedBy: null,
      lockedUntil: null,
      lastError: 'execution lease expired after the maximum number of attempts',
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        gte(projectTriggerExecutions.attempts, 5),
        or(
          and(
            eq(projectTriggerExecutions.status, 'queued'),
            lte(projectTriggerExecutions.availableAt, input.now),
          ),
          and(
            eq(projectTriggerExecutions.status, 'running'),
            or(
              isNull(projectTriggerExecutions.lockedUntil),
              lte(projectTriggerExecutions.lockedUntil, input.now),
            ),
          ),
        ),
      ),
    );

  const candidates = await db
    .select()
    .from(projectTriggerExecutions)
    .where(
      and(
        lt(projectTriggerExecutions.attempts, 5),
        or(
          and(
            eq(projectTriggerExecutions.status, 'queued'),
            lte(projectTriggerExecutions.availableAt, input.now),
          ),
          and(
            eq(projectTriggerExecutions.status, 'running'),
            or(
              isNull(projectTriggerExecutions.lockedUntil),
              lte(projectTriggerExecutions.lockedUntil, input.now),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(projectTriggerExecutions.availableAt), asc(projectTriggerExecutions.createdAt))
    .limit(input.limit);

  const claimed = await mapConcurrently(candidates, 8, async (candidate) => {
    const [row] = await db
      .update(projectTriggerExecutions)
      .set({
        status: 'running',
        attempts: candidate.attempts + 1,
        lockedBy: input.workerId,
        lockedUntil: new Date(input.now.getTime() + leaseMs),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(projectTriggerExecutions.executionId, candidate.executionId),
          eq(projectTriggerExecutions.attempts, candidate.attempts),
          or(
            eq(projectTriggerExecutions.status, 'queued'),
            and(
              eq(projectTriggerExecutions.status, 'running'),
              or(
                isNull(projectTriggerExecutions.lockedUntil),
                lte(projectTriggerExecutions.lockedUntil, input.now),
              ),
            ),
          ),
        ),
      )
      .returning();
    return row ?? null;
  });
  return claimed.filter((row): row is TriggerExecutionRow => row !== null);
}

function ownedRunningExecution(row: TriggerExecutionRow) {
  return and(
    eq(projectTriggerExecutions.executionId, row.executionId),
    eq(projectTriggerExecutions.status, 'running'),
    eq(projectTriggerExecutions.attempts, row.attempts),
  );
}

export async function markTriggerExecutionDispatched(input: {
  row: TriggerExecutionRow;
  dispatchedAt: Date;
}): Promise<void> {
  await db
    .update(projectTriggerExecutions)
    .set({
      dispatchedAt: input.dispatchedAt,
      updatedAt: input.dispatchedAt,
    })
    .where(ownedRunningExecution(input.row));
}

export async function markTriggerExecutionSucceeded(input: {
  row: TriggerExecutionRow;
  completedAt: Date;
  sessionId?: string | null;
  commandId?: string | null;
}): Promise<void> {
  await db
    .update(projectTriggerExecutions)
    .set({
      status: 'succeeded',
      sessionId: input.sessionId ?? null,
      commandId: input.commandId ?? null,
      completedAt: input.completedAt,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      updatedAt: input.completedAt,
    })
    .where(ownedRunningExecution(input.row));
}

export async function markTriggerExecutionSkipped(input: {
  row: TriggerExecutionRow;
  skippedAt: Date;
  reason: string;
}): Promise<void> {
  await db
    .update(projectTriggerExecutions)
    .set({
      status: 'skipped',
      lockedBy: null,
      lockedUntil: null,
      lastError: input.reason.slice(0, 2_000),
      completedAt: input.skippedAt,
      updatedAt: input.skippedAt,
    })
    .where(ownedRunningExecution(input.row));
}

export async function markTriggerExecutionFailed(input: {
  row: TriggerExecutionRow;
  failedAt: Date;
  error: string;
}): Promise<'queued' | 'dead_lettered'> {
  const terminal = input.row.attempts >= 5;
  const retryDelayMs = Math.min(60_000, 2 ** Math.max(0, input.row.attempts - 1) * 2_000);
  await db
    .update(projectTriggerExecutions)
    .set({
      status: terminal ? 'dead_lettered' : 'queued',
      availableAt: terminal ? input.failedAt : new Date(input.failedAt.getTime() + retryDelayMs),
      lockedBy: null,
      lockedUntil: null,
      lastError: input.error.slice(0, 2_000),
      completedAt: terminal ? input.failedAt : null,
      updatedAt: input.failedAt,
    })
    .where(ownedRunningExecution(input.row));
  return terminal ? 'dead_lettered' : 'queued';
}

export async function countUncatalogedTriggerProjects(): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(distinct ${projectTriggerRuntime.projectId})` })
    .from(projectTriggerRuntime)
    .innerJoin(projects, eq(projects.projectId, projectTriggerRuntime.projectId))
    .where(and(eq(projects.status, 'active'), isNull(projectTriggerRuntime.scheduleRevision)));
  return Number(rows[0]?.count ?? 0);
}
