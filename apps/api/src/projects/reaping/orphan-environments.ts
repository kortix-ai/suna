/**
 * Reclaim session environments nothing else will.
 *
 * `session-environment.ts` records this against itself: *"Environments have no
 * session_sandboxes row, so the box reaper does not manage them yet: the
 * provider's own idle timer is the ONLY stop… Metering + reaper tie-in is the
 * recorded fast-follow."* Metering landed; this is the reaper half.
 *
 * The ordinary paths are covered — session stop calls `stopSessionEnvironment`,
 * session delete calls `deleteSessionEnvironment`. The gap is the session that
 * gets neither: abandoned, or a crash between the two. Its row then survives
 * every existing sweep, and it survives them for two DIFFERENT reasons:
 *
 *  - `reapAndReconcileSandboxes` is driven by `session_sandboxes`. An
 *    environment has no row there, so it is not a candidate at all.
 *  - `reapOrphanProviderBoxes` works from the provider side, and its keepSet
 *    holds every `session_environments` row whose status is active or
 *    provisioning. That entry is deliberate — without it the sweep stopped the
 *    box out from under a live pi session — but it is unconditional on age, so
 *    an abandoned `active` row pins its box out of reach permanently. And a row
 *    that has gone `stopped` is not saved by the keepSet yet is still invisible
 *    there, because that sweep lists only RUNNING boxes.
 *
 * So the row is never deleted, the provider box is never deleted, and both
 * sweeps decline it for reasons that are individually correct. This pass is the
 * one that reads the session.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { projectSessions, sessionEnvironments } from '@kortix/db';
import { db } from '../../shared/db';
import { deleteSessionEnvironment } from '../../platform/services/session-environment-teardown';

/**
 * How long an environment may sit unused before it is reclaimed.
 *
 * Long enough that someone returning to yesterday's session resumes it instead
 * of paying a fresh provision.
 */
export const ENVIRONMENT_IDLE_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Grace after a delete, so this never races the inline teardown.
 *
 * `deleteSession` already calls `deleteSessionEnvironment` directly. Two paths
 * deleting one provider box is harmless — the provider call is best-effort —
 * but it is a pointless round trip and a confusing log line.
 */
export const DELETED_SESSION_GRACE_MS = 5 * 60 * 1000;

export interface EnvironmentReapCandidate {
  sessionId: string;
  /** `metadata.deletedAt` on the session, if it is soft-deleted. */
  sessionDeletedAt: Date | null;
  /** True when no `project_sessions` row exists at all. */
  sessionMissing: boolean;
  lastUsedAt: Date | null;
}

/**
 * The decision, as a pure function — this is the part that, wrong, deletes a
 * box someone is using.
 */
export function selectReapableEnvironments(
  candidates: EnvironmentReapCandidate[],
  now: Date,
  options?: { idleHorizonMs?: number; deletedGraceMs?: number },
): string[] {
  const idleHorizon = options?.idleHorizonMs ?? ENVIRONMENT_IDLE_HORIZON_MS;
  const deletedGrace = options?.deletedGraceMs ?? DELETED_SESSION_GRACE_MS;
  const t = now.getTime();

  return candidates
    .filter((c) => {
      // No session row at all: nothing will ever tear this down.
      if (c.sessionMissing) return true;
      // Soft-deleted, past the window where its own teardown would have run.
      if (c.sessionDeletedAt) return t - c.sessionDeletedAt.getTime() > deletedGrace;
      // Live but abandoned. A NULL lastUsedAt is "unknown", never "ancient" —
      // reading it as epoch would reap a box created seconds ago that has not
      // recorded a use yet.
      if (!c.lastUsedAt) return false;
      return t - c.lastUsedAt.getTime() > idleHorizon;
    })
    .map((c) => c.sessionId);
}

export interface EnvironmentReapResult {
  scanned: number;
  reaped: number;
  errors: number;
}

/** One pass. Bounded, so a backlog drains across runs instead of in one cycle. */
export async function reapOrphanEnvironments(options?: {
  limit?: number;
  now?: Date;
  idleHorizonMs?: number;
}): Promise<EnvironmentReapResult> {
  const zero: EnvironmentReapResult = { scanned: 0, reaped: 0, errors: 0 };
  if (process.env.KORTIX_ENVIRONMENT_REAP_ENABLED === 'false') return zero;

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
  const now = options?.now ?? new Date();
  const idleHorizonMs = options?.idleHorizonMs ?? ENVIRONMENT_IDLE_HORIZON_MS;
  // One cutoff for both the query and the pure filter. Computing the SQL
  // interval independently is how a `now`/horizon override silently stops
  // agreeing with the decision function it feeds.
  const idleCutoff = new Date(now.getTime() - idleHorizonMs);

  const rows = await db
    .select({
      sessionId: sessionEnvironments.sessionId,
      lastUsedAt: sessionEnvironments.lastUsedAt,
      sessionRowId: projectSessions.sessionId,
      deletedAt: sql<string | null>`${projectSessions.metadata}->>'deletedAt'`,
    })
    .from(sessionEnvironments)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, sessionEnvironments.sessionId))
    .where(
      or(
        isNull(projectSessions.sessionId),
        sql`(${projectSessions.metadata}->>'deletedAt') is not null`,
        and(
          sql`${sessionEnvironments.lastUsedAt} is not null`,
          sql`${sessionEnvironments.lastUsedAt} < ${idleCutoff}`,
        ),
      ),
    )
    .limit(limit);

  if (rows.length === 0) return zero;

  const reapable = selectReapableEnvironments(
    rows.map((r) => ({
      sessionId: r.sessionId,
      sessionDeletedAt: r.deletedAt ? new Date(r.deletedAt) : null,
      sessionMissing: r.sessionRowId === null,
      lastUsedAt: r.lastUsedAt ?? null,
    })),
    now,
    { idleHorizonMs },
  );

  let reaped = 0;
  let errors = 0;
  for (const sessionId of reapable) {
    try {
      // The same teardown session delete calls: powers the box off, ends
      // metering, drops the row. One path, so the two cannot diverge.
      await deleteSessionEnvironment(sessionId);
      reaped += 1;
    } catch (err) {
      errors += 1;
      if (errors <= 5) {
        console.warn(
          `[reaper] environment reap of ${sessionId} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return { scanned: rows.length, reaped, errors };
}
