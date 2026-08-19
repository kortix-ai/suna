/**
 * The monitor ingest write path: authenticate the box's sandbox token, then
 * append its batch to `project_monitor_events`.
 *
 * The log IS the queue (spec D2) — this module only writes; the observer
 * (./monitor-observer.ts) drains. Every bound it enforces is platform-side:
 * the runner is repo code and cannot be trusted to police itself.
 */
import { projectMonitorBoxes, projectMonitorEvents, projectTriggerRuntime } from '@kortix/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  MONITOR_BURST_WINDOW_MS,
  MONITOR_RATE_WINDOW_MS,
  type ParsedMonitorEvent,
  monitorRateVerdict,
  nextMonitorSuppression,
} from './monitor-events';

/** Box states that may ingest. A stopped/error/deleted box has no live runner. */
const LIVE_BOX_STATUSES = ['provisioning', 'starting', 'running', 'stopping'] as const;

export interface MonitorBoxRow {
  boxId: string;
  projectId: string;
  boxEpoch: string;
}

/**
 * Resolve the monitor box a sandbox token belongs to.
 *
 * A monitor box is NOT a session sandbox — it has no `session_sandboxes` row —
 * so it authenticates against `project_monitor_boxes` alone, scoped by
 * project AND account so a token from another tenant's box can never ingest
 * here (spec §"Security model": "only accepts events for that box's own
 * project").
 *
 * The token's sandbox id is the `box_id`, NOT the provider's external id: the
 * token has to exist before `provider.create()` is called (it is injected as
 * the box's env), so at mint time there is no external id yet. This mirrors a
 * session, whose token is likewise minted against the internal `sandbox_id`.
 */
export async function loadMonitorBoxForToken(input: {
  projectId: string;
  accountId: string;
  sandboxId: string;
}): Promise<MonitorBoxRow | null> {
  const [box] = await db
    .select({
      boxId: projectMonitorBoxes.boxId,
      projectId: projectMonitorBoxes.projectId,
      boxEpoch: projectMonitorBoxes.boxEpoch,
    })
    .from(projectMonitorBoxes)
    .where(
      and(
        eq(projectMonitorBoxes.boxId, input.sandboxId),
        eq(projectMonitorBoxes.projectId, input.projectId),
        eq(projectMonitorBoxes.accountId, input.accountId),
        inArray(projectMonitorBoxes.status, [...LIVE_BOX_STATUSES]),
      ),
    )
    .limit(1);
  return box ?? null;
}

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
