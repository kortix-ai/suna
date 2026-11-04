/**
 * The event log's write path: append a batch to `project_monitor_events`.
 * App events (./app-events.ts) are its only writer since the monitor box was
 * removed; the table keeps its name.
 *
 * The log IS the queue — this module only writes; the observer
 * (./monitor-observer.ts) drains. Every bound it enforces is platform-side:
 * the writer is App code and cannot be trusted to police itself.
 */
import { projectMonitorEvents, projectTriggerRuntime } from '@kortix/db';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  MONITOR_BURST_WINDOW_MS,
  MONITOR_RATE_WINDOW_MS,
  type ParsedMonitorEvent,
  monitorRateVerdict,
  nextMonitorSuppression,
} from './monitor-events';

export interface MonitorIngestResult {
  accepted: number;
  deduped: number;
  suppressed: number;
}

/**
 * Append one batch. Insertion is `ON CONFLICT DO NOTHING` on the
 * `(project_id, slug, box_epoch, seq)` dedup index, so an at-least-once POST
 * retry costs one no-op write instead of a duplicate agent turn.
 */
export async function ingestMonitorEvents(input: {
  projectId: string;
  boxEpoch: string;
  events: readonly ParsedMonitorEvent[];
  now?: Date;
}): Promise<MonitorIngestResult> {
  const now = input.now ?? new Date();
  const result: MonitorIngestResult = { accepted: 0, deduped: 0, suppressed: 0 };

  const slugs = [...new Set(input.events.map((event) => event.slug))];
  const windows = new Map<string, { hourCount: number; burstCount: number }>();
  const runtimes = new Map<
    string,
    { suppressedUntil: Date | null; suppressionCount: number | null }
  >();
  for (const slug of slugs) {
    windows.set(slug, await countMonitorRateWindow(input.projectId, slug, now));
    runtimes.set(slug, await loadMonitorRuntimeState(input.projectId, slug));
  }

  for (const event of input.events) {
    const window = windows.get(event.slug)!;
    const runtime = runtimes.get(event.slug)!;
    const verdict = monitorRateVerdict(
      { ...window, suppressedUntil: runtime.suppressedUntil },
      now,
    );
    const status = verdict === 'accept' ? 'pending' : 'suppressed';

    const inserted = await db
      .insert(projectMonitorEvents)
      .values({
        projectId: input.projectId,
        slug: event.slug,
        boxEpoch: input.boxEpoch,
        seq: event.seq,
        kind: event.kind,
        line: event.line,
        emittedAt: event.emittedAt,
        ingestedAt: now,
        status,
      })
      .onConflictDoNothing({
        target: [
          projectMonitorEvents.projectId,
          projectMonitorEvents.slug,
          projectMonitorEvents.boxEpoch,
          projectMonitorEvents.seq,
        ],
      })
      .returning({ eventId: projectMonitorEvents.eventId });

    if (!inserted[0]) {
      result.deduped += 1;
      continue;
    }
    // Only a row we actually stored counts against the rate window.
    window.hourCount += 1;
    window.burstCount += 1;
    if (verdict === 'accept') {
      result.accepted += 1;
      continue;
    }
    result.suppressed += 1;
    const suppression = nextMonitorSuppression({
      now,
      suppressedUntil: runtime.suppressedUntil,
      suppressionCount: runtime.suppressionCount,
    });
    runtime.suppressedUntil = suppression.suppressedUntil;
    runtime.suppressionCount = suppression.suppressionCount;
    if (suppression.opensNewEpisode) {
      await applyMonitorSuppression(input.projectId, event.slug, now, suppression);
    }
  }
  return result;
}

async function countMonitorRateWindow(
  projectId: string,
  slug: string,
  now: Date,
): Promise<{ hourCount: number; burstCount: number }> {
  const [row] = await db
    .select({
      hourCount: sql<number>`count(*)`,
      // The burst cutoff is interpolated as an ISO string + cast, NOT a Date:
      // inside a raw sql`` fragment drizzle does not apply the column's driver
      // mapping, and postgres.js cannot bind a Date instance (500 on ingest —
      // caught live 2026-08-12).
      burstCount: sql<number>`count(*) filter (where ${projectMonitorEvents.ingestedAt} >= ${new Date(now.getTime() - MONITOR_BURST_WINDOW_MS).toISOString()}::timestamptz)`,
    })
    .from(projectMonitorEvents)
    .where(
      and(
        eq(projectMonitorEvents.projectId, projectId),
        eq(projectMonitorEvents.slug, slug),
        gte(projectMonitorEvents.ingestedAt, new Date(now.getTime() - MONITOR_RATE_WINDOW_MS)),
      ),
    );
  return { hourCount: Number(row?.hourCount ?? 0), burstCount: Number(row?.burstCount ?? 0) };
}

async function loadMonitorRuntimeState(
  projectId: string,
  slug: string,
): Promise<{ suppressedUntil: Date | null; suppressionCount: number | null }> {
  const [row] = await db
    .select({
      suppressedUntil: projectTriggerRuntime.suppressedUntil,
      suppressionCount: projectTriggerRuntime.suppressionCount,
    })
    .from(projectTriggerRuntime)
    .where(
      and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
    )
    .limit(1);
  return {
    suppressedUntil: row?.suppressedUntil ?? null,
    suppressionCount: row?.suppressionCount ?? null,
  };
}

/**
 * Record a suppression episode, and disable the monitor on the third episode
 * inside 24 h. The disable is a runtime-row write, not a manifest edit — the
 * repo stays the source of truth, and re-enabling is a manifest change the
 * catalog reconcile picks up.
 */
async function applyMonitorSuppression(
  projectId: string,
  slug: string,
  now: Date,
  suppression: { suppressedUntil: Date; suppressionCount: number; autoDisable: boolean },
): Promise<void> {
  await db
    .update(projectTriggerRuntime)
    .set({
      suppressedUntil: suppression.suppressedUntil,
      suppressionCount: suppression.suppressionCount,
      updatedAt: now,
      ...(suppression.autoDisable
        ? {
            enabled: false,
            lastError: `monitor auto-disabled after ${suppression.suppressionCount} event-rate suppressions in 24h — reduce its output or raise its filter, then re-enable it in kortix.yaml`,
            lastAttemptAt: now,
          }
        : {}),
    })
    .where(
      and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
    );
}

/** Days an event stays in the log. */
export const MONITOR_EVENT_RETENTION_DAYS = 30;
/** Rows deleted per retention pass, so one sweep can never stampede the DB. */
const MONITOR_RETENTION_BATCH = 5_000;

/**
 * Delete events past the retention horizon. Bounded per pass — the log is
 * append-only and a busy App can produce thousands of rows a day, so an
 * unbounded DELETE would be a lock-holding surprise on the maintenance tick.
 */
export async function purgeExpiredMonitorEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MONITOR_EVENT_RETENTION_DAYS * 24 * 60 * 60_000);
  const doomed = await db
    .select({ eventId: projectMonitorEvents.eventId })
    .from(projectMonitorEvents)
    .where(lt(projectMonitorEvents.ingestedAt, cutoff))
    .orderBy(asc(projectMonitorEvents.ingestedAt))
    .limit(MONITOR_RETENTION_BATCH);
  if (doomed.length === 0) return 0;
  await db.delete(projectMonitorEvents).where(inArray(projectMonitorEvents.eventId, doomed.map((row) => row.eventId)));
  return doomed.length;
}
