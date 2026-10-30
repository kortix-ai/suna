/**
 * Trigger run caps (KRTX-1721): a trigger starts at most `max_runs_per_hour`
 * runs in any 60 minutes (`DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR` when unset) and
 * at most `max_runs_per_day` in a UTC day. A fire past a cap starts nothing:
 * `fireGitTrigger` answers `skipped` with the reason this returns.
 *
 * A run counts once its fire reached a session or a queued create (`succeeded`,
 * `requeued`). Skipped, failed and rejected fires started nothing. A cron
 * slot's own row is `running` while it fires, so it does not count itself.
 * Two fires of one trigger that check at the same moment can both pass: the
 * cap holds to within the fires in flight.
 *
 * Auto-pause: a trigger the hourly limit holds after it ran at that limit
 * through the previous hour pauses itself (`project_trigger_runtime.
 * auto_paused_at`) until someone resumes it (`PATCH enabled: true`).
 */
import { projectTriggerExecutions, projectTriggerRuntime } from '@kortix/db';
import { DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR } from '@kortix/manifest-schema';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

const HOUR_MS = 60 * 60 * 1000;

export interface TriggerRunCaps {
  maxRunsPerHour?: number;
  maxRunsPerDay?: number;
}

export interface TriggerRunCapVerdict {
  reason: string;
  /**
   * The hourly limit held this fire AND the trigger ran at that limit through
   * the hour before the last one: a runaway, not a burst. The fire path
   * auto-pauses the trigger. A daily limit never sets it: holding the rest of
   * the day is that limit's purpose. Nor does a breach within 2 hours of a
   * resume: the runs before the resume do not count against it.
   */
  sustained: boolean;
}

/** Why this fire may not start a run, or null when it may. */
export async function triggerRunCapVerdict(input: {
  projectId: string;
  slug: string;
  caps: TriggerRunCaps;
  now: Date;
  /** When the trigger was last resumed from an auto-pause. */
  resumedAt?: Date | null;
}): Promise<TriggerRunCapVerdict | null> {
  const perHour = input.caps.maxRunsPerHour ?? DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR;
  const perDay = input.caps.maxRunsPerDay ?? null;
  const hourAgo = new Date(input.now.getTime() - HOUR_MS);
  const twoHoursAgo = new Date(input.now.getTime() - 2 * HOUR_MS);
  const dayStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()));
  const since = perDay !== null && dayStart < twoHoursAgo ? dayStart : twoHoursAgo;
  const createdAt = projectTriggerExecutions.createdAt;
  const [counts] = await db
    .select({
      hour: sql<number>`count(*) filter (where ${createdAt} > ${hourAgo.toISOString()}::timestamptz)::int`,
      previousHour: sql<number>`count(*) filter (where ${createdAt} > ${twoHoursAgo.toISOString()}::timestamptz and ${createdAt} <= ${hourAgo.toISOString()}::timestamptz)::int`,
      day: sql<number>`count(*) filter (where ${createdAt} >= ${dayStart.toISOString()}::timestamptz)::int`,
    })
    .from(projectTriggerExecutions)
    .where(
      and(
        eq(projectTriggerExecutions.projectId, input.projectId),
        eq(projectTriggerExecutions.slug, input.slug),
        inArray(projectTriggerExecutions.status, ['succeeded', 'requeued']),
        gt(createdAt, since),
        sql`${createdAt} <= ${input.now.toISOString()}::timestamptz`,
      ),
    );
  const hour = counts?.hour ?? 0;
  const day = counts?.day ?? 0;
  if (hour >= perHour) {
    return {
      reason: `throttled: ${hour} runs in the last hour (max_runs_per_hour ${perHour})`,
      sustained: (counts?.previousHour ?? 0) >= perHour && !(input.resumedAt && input.resumedAt > twoHoursAgo),
    };
  }
  if (perDay !== null && day >= perDay) return { reason: `throttled: ${day} runs today, UTC (max_runs_per_day ${perDay})`, sustained: false };
  return null;
}

/** Why this fire may not start a run, or null when it may. */
export async function triggerRunCapReason(input: Parameters<typeof triggerRunCapVerdict>[0]): Promise<string | null> {
  return (await triggerRunCapVerdict(input))?.reason ?? null;
}

/** The reason an auto-paused trigger's fires carry. */
export function triggerAutoPauseReason(caps: TriggerRunCaps): string {
  return `auto-paused: ran at max_runs_per_hour ${caps.maxRunsPerHour ?? DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR} for 2 hours in a row`;
}

const runtimeRow = (projectId: string, slug: string) =>
  and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug));

/** The auto-pause reason while auto-paused (else null), and the last resume. */
export async function readTriggerAutoPause(projectId: string, slug: string): Promise<{ pausedReason: string | null; resumedAt: Date | null }> {
  const [row] = await db
    .select({
      at: projectTriggerRuntime.autoPausedAt,
      reason: projectTriggerRuntime.autoPausedReason,
      resumedAt: projectTriggerRuntime.autoPauseResumedAt,
    })
    .from(projectTriggerRuntime)
    .where(runtimeRow(projectId, slug))
    .limit(1);
  return { pausedReason: row?.at ? (row.reason ?? 'auto-paused') : null, resumedAt: row?.resumedAt ?? null };
}

/**
 * Auto-pause the trigger. True only for the call that paused it, so the
 * watchers hear once. False when it was paused already or has no runtime row.
 */
export async function autoPauseTrigger(projectId: string, slug: string, reason: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(projectTriggerRuntime)
    .set({ autoPausedAt: now, autoPausedReason: reason, updatedAt: now })
    .where(and(runtimeRow(projectId, slug), isNull(projectTriggerRuntime.autoPausedAt)))
    .returning({ slug: projectTriggerRuntime.slug });
  return rows.length > 0;
}

/** Resume an auto-paused trigger. True when it was auto-paused. */
export async function clearTriggerAutoPause(projectId: string, slug: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(projectTriggerRuntime)
    .set({ autoPausedAt: null, autoPausedReason: null, autoPauseResumedAt: now, updatedAt: now })
    .where(and(runtimeRow(projectId, slug), isNotNull(projectTriggerRuntime.autoPausedAt)))
    .returning({ slug: projectTriggerRuntime.slug });
  return rows.length > 0;
}

const THROTTLED_RUN_EVERY_MS = 10_000;
// replica-local: the last throttled run row this process wrote per
// `<project>:<slug>`. A storm past a cap writes at most one history row per
// trigger per 10 s per replica; cron updates its own slot row instead.
const throttledRunWrittenAt = new Map<string, number>();

/** True when a throttled fire of this trigger may write its skipped run now. */
export function takeThrottledRunSlot(projectId: string, slug: string, now: Date = new Date()): boolean {
  const key = `${projectId}:${slug}`;
  const last = throttledRunWrittenAt.get(key);
  if (last !== undefined && now.getTime() - last < THROTTLED_RUN_EVERY_MS) return false;
  if (throttledRunWrittenAt.size >= 10_000) throttledRunWrittenAt.clear();
  throttledRunWrittenAt.set(key, now.getTime());
  return true;
}
