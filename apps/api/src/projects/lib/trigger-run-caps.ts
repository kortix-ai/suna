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
 */
import { projectTriggerExecutions } from '@kortix/db';
import { DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR } from '@kortix/manifest-schema';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

const HOUR_MS = 60 * 60 * 1000;

export interface TriggerRunCaps {
  maxRunsPerHour?: number;
  maxRunsPerDay?: number;
}

/** Why this fire may not start a run, or null when it may. */
export async function triggerRunCapReason(input: {
  projectId: string;
  slug: string;
  caps: TriggerRunCaps;
  now: Date;
}): Promise<string | null> {
  const perHour = input.caps.maxRunsPerHour ?? DEFAULT_TRIGGER_MAX_RUNS_PER_HOUR;
  const perDay = input.caps.maxRunsPerDay ?? null;
  const hourAgo = new Date(input.now.getTime() - HOUR_MS);
  const dayStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()));
  const since = perDay !== null && dayStart < hourAgo ? dayStart : hourAgo;
  const createdAt = projectTriggerExecutions.createdAt;
  const [counts] = await db
    .select({
      hour: sql<number>`count(*) filter (where ${createdAt} > ${hourAgo.toISOString()}::timestamptz)::int`,
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
  if (hour >= perHour) return `throttled: ${hour} runs in the last hour (max_runs_per_hour ${perHour})`;
  if (perDay !== null && day >= perDay) return `throttled: ${day} runs today, UTC (max_runs_per_day ${perDay})`;
  return null;
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
