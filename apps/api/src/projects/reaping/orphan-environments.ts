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
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { projectSessions, sessionEnvironments } from '@kortix/db';
import { db } from '../../shared/db';
import {
  deleteSessionEnvironment,
  stopSessionEnvironment,
} from '../../platform/services/session-environment-teardown';

/**
 * Idle long enough to STOP: power the box off, keep the row and the disk.
 *
 * The provider's own `autoStopInterval: 60` already stops an idle environment
 * after an hour, so this rarely has anything to do — it is the backstop for a
 * box whose auto-stop did not fire. Reversible either way: `ensure` resumes a
 * row whose status reads 'stopped'.
 */
export const ENVIRONMENT_IDLE_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Idle long enough to DELETE, which is a different question and deserves a
 * different answer.
 *
 * An environment is where the agent ACTS — it holds the session's working
 * tree. Committed work is safe (it lives on the session branch in the git
 * mirror), but uncommitted working-tree changes exist only in that box, and
 * deleting it destroys them with no warning and no undo. On pi.kortix.com,
 * 16 of 21 environments were idle past 24h; reaping those on the short horizon
 * would have thrown away sixteen live sessions' uncommitted work to reclaim
 * quota the provider's auto-stop had already stopped billing for.
 *
 * So the short horizon stops and the long one deletes. A week of silence is
 * evidence nobody is coming back; a day is not.
 */
export const ENVIRONMENT_DELETE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Grace after a delete, so this never races the inline teardown.
 *
 * `deleteSession` already calls `deleteSessionEnvironment` directly. Two paths
 * deleting one provider box is harmless — the provider call is best-effort —
 * but it is a pointless round trip and a confusing log line.
 */
export const DELETED_SESSION_GRACE_MS = 5 * 60 * 1000;

/**
 * How long a worker must have been parked before its environment follows.
 *
 * `restartSession` and a wake both move a session out of a terminal status;
 * acting inside this window would stop the environment out from under a
 * session that is coming straight back.
 */
export const WORKER_STOP_SETTLE_MS = 5 * 60 * 1000;

/**
 * The worker statuses that mean "this session is parked".
 *
 * Deliberately the same three `maintenance.ts` calls TERMINAL_SESSION_STATUSES.
 * `queued`/`branching`/`provisioning`/`running` are all live.
 */
const PARKED_WORKER_STATUSES = new Set(['stopped', 'failed', 'completed']);

export interface EnvironmentReapCandidate {
  sessionId: string;
  /** `metadata.deletedAt` on the session, if it is soft-deleted. */
  sessionDeletedAt: Date | null;
  /** True when no `project_sessions` row exists at all. */
  sessionMissing: boolean;
  lastUsedAt: Date | null;
  /** `project_sessions.status` — the worker's state, not the environment's. */
  workerStatus: string | null;
  /** When that status last moved, for the settle window. */
  workerUpdatedAt: Date | null;
  /** `session_environments.status`, so an already-parked box is not re-stopped. */
  environmentStatus: string | null;
}

/** What to do with one environment. */
export type EnvironmentReapAction = 'stop' | 'delete';

export interface EnvironmentReapDecision {
  sessionId: string;
  action: EnvironmentReapAction;
  /** Why, for the log — a reaper that cannot explain itself cannot be trusted. */
  reason: 'session-missing' | 'session-deleted' | 'worker-stopped' | 'idle-delete' | 'idle-stop';
}

/**
 * The decision, as a pure function — this is the part that, wrong, destroys
 * someone's uncommitted work.
 *
 * The action follows the evidence:
 *  - the session is GONE (no row, or soft-deleted past its teardown window):
 *    nothing can ever want this environment again, so delete it.
 *  - the session is LIVE but silent for a week: delete.
 *  - the session is LIVE and merely idle: stop only. Reversible, and `ensure`
 *    resumes it.
 */
export function decideEnvironmentReaping(
  candidates: EnvironmentReapCandidate[],
  now: Date,
  options?: {
    idleHorizonMs?: number;
    deleteHorizonMs?: number;
    deletedGraceMs?: number;
    workerSettleMs?: number;
  },
): EnvironmentReapDecision[] {
  const idleHorizon = options?.idleHorizonMs ?? ENVIRONMENT_IDLE_HORIZON_MS;
  const deleteHorizon = options?.deleteHorizonMs ?? ENVIRONMENT_DELETE_HORIZON_MS;
  const deletedGrace = options?.deletedGraceMs ?? DELETED_SESSION_GRACE_MS;
  const workerSettle = options?.workerSettleMs ?? WORKER_STOP_SETTLE_MS;
  const t = now.getTime();
  const out: EnvironmentReapDecision[] = [];

  for (const c of candidates) {
    // No session row at all: nothing will ever tear this down, and nothing can
    // ever resume it.
    if (c.sessionMissing) {
      out.push({ sessionId: c.sessionId, action: 'delete', reason: 'session-missing' });
      continue;
    }
    // Soft-deleted, past the window where its own inline teardown would have run.
    if (c.sessionDeletedAt) {
      if (t - c.sessionDeletedAt.getTime() > deletedGrace) {
        out.push({ sessionId: c.sessionId, action: 'delete', reason: 'session-deleted' });
      }
      continue;
    }
    // The worker is parked, so the environment has nothing left to serve.
    //
    // This is the tie-in for all THIRTEEN automatic stop paths at once. Six of
    // them bypass `applyStoppedState`, and `stopSessionEnvironment` is called
    // from only two places, both user-triggered — so there is no funnel to hook.
    // What every durable park DOES share is a write to `project_sessions.status`
    // in the same transaction, and this sweep already joins that table. Deriving
    // the state cannot drift out of sync with a stop path nobody updated.
    //
    // Stop, never delete: a parked worker is an ordinary resumable state.
    if (
      c.workerStatus &&
      PARKED_WORKER_STATUSES.has(c.workerStatus) &&
      c.environmentStatus !== 'stopped' &&
      c.workerUpdatedAt &&
      t - c.workerUpdatedAt.getTime() > workerSettle
    ) {
      out.push({ sessionId: c.sessionId, action: 'stop', reason: 'worker-stopped' });
      continue;
    }
    // Live. A NULL lastUsedAt is "unknown", never "ancient" — reading it as
    // epoch would reap a box created seconds ago that has not recorded a use yet.
    if (!c.lastUsedAt) continue;
    const idleFor = t - c.lastUsedAt.getTime();
    if (idleFor > deleteHorizon) {
      out.push({ sessionId: c.sessionId, action: 'delete', reason: 'idle-delete' });
    } else if (idleFor > idleHorizon) {
      out.push({ sessionId: c.sessionId, action: 'stop', reason: 'idle-stop' });
    }
  }
  return out;
}

export interface EnvironmentReapResult {
  scanned: number;
  stopped: number;
  deleted: number;
  errors: number;
}

/** One pass. Bounded, so a backlog drains across runs instead of in one cycle. */
export async function reapOrphanEnvironments(options?: {
  limit?: number;
  now?: Date;
  idleHorizonMs?: number;
  deleteHorizonMs?: number;
}): Promise<EnvironmentReapResult> {
  const zero: EnvironmentReapResult = { scanned: 0, stopped: 0, deleted: 0, errors: 0 };
  if (process.env.KORTIX_ENVIRONMENT_REAP_ENABLED === 'false') return zero;

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
  const now = options?.now ?? new Date();
  const idleHorizonMs = options?.idleHorizonMs ?? ENVIRONMENT_IDLE_HORIZON_MS;
  const deleteHorizonMs = options?.deleteHorizonMs ?? ENVIRONMENT_DELETE_HORIZON_MS;
  // One cutoff for both the query and the pure rule. Computing the SQL interval
  // independently is how a `now`/horizon override silently stops agreeing with
  // the decision function it feeds. The query uses the SHORTER horizon — it
  // selects everything either branch might act on, and the rule sorts them.
  const idleCutoff = new Date(now.getTime() - Math.min(idleHorizonMs, deleteHorizonMs));

  const rows = await db
    .select({
      sessionId: sessionEnvironments.sessionId,
      lastUsedAt: sessionEnvironments.lastUsedAt,
      status: sessionEnvironments.status,
      sessionRowId: projectSessions.sessionId,
      workerStatus: projectSessions.status,
      workerUpdatedAt: projectSessions.updatedAt,
      deletedAt: sql<string | null>`${projectSessions.metadata}->>'deletedAt'`,
    })
    .from(sessionEnvironments)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, sessionEnvironments.sessionId))
    .where(
      or(
        isNull(projectSessions.sessionId),
        sql`(${projectSessions.metadata}->>'deletedAt') is not null`,
        // A parked worker qualifies regardless of how recently the environment
        // was used — that is the whole point of the tie-in. Bounded by the
        // environment not already being stopped, so a fleet of parked sessions
        // does not re-enter this set every tick forever.
        and(
          inArray(projectSessions.status, ['stopped', 'failed', 'completed']),
          ne(sessionEnvironments.status, 'stopped'),
        ),
        and(
          // Drizzle operators, not a raw `sql` fragment. Interpolating a JS Date
          // into `sql` hands the postgres driver an unmapped value and the query
          // dies with `The "string" argument must be of type string ... Received
          // an instance of Date` — the column's type mapper is what encodes it,
          // and a raw fragment has no column to ask. Caught only by running this
          // against a real database; the pure-rule unit tests cannot see it.
          isNotNull(sessionEnvironments.lastUsedAt),
          lt(sessionEnvironments.lastUsedAt, idleCutoff),
        ),
      ),
    )
    .limit(limit);

  if (rows.length === 0) return zero;

  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  const decisions = decideEnvironmentReaping(
    rows.map((r) => ({
      sessionId: r.sessionId,
      sessionDeletedAt: r.deletedAt ? new Date(r.deletedAt) : null,
      sessionMissing: r.sessionRowId === null,
      lastUsedAt: r.lastUsedAt ?? null,
      workerStatus: r.workerStatus ?? null,
      workerUpdatedAt: r.workerUpdatedAt ?? null,
      environmentStatus: r.status ?? null,
    })),
    now,
    { idleHorizonMs, deleteHorizonMs },
  );

  let stopped = 0;
  let deleted = 0;
  let errors = 0;
  for (const decision of decisions) {
    // Nothing to stop on a row that already reads 'stopped'. The provider's own
    // auto-stop gets there first almost every time, so without this the sweep
    // would issue a pointless provider call for every idle environment, every
    // five minutes, forever.
    if (decision.action === 'stop' && byId.get(decision.sessionId)?.status === 'stopped') continue;
    try {
      if (decision.action === 'delete') {
        // The same teardown session delete calls: powers the box off, ends
        // metering, drops the row. One path, so the two cannot diverge.
        await deleteSessionEnvironment(decision.sessionId);
        deleted += 1;
      } else {
        await stopSessionEnvironment(decision.sessionId);
        stopped += 1;
      }
      console.log(
        `[reaper] environment ${decision.action}: ${decision.sessionId} (${decision.reason})`,
      );
    } catch (err) {
      errors += 1;
      if (errors <= 5) {
        console.warn(
          `[reaper] environment ${decision.action} of ${decision.sessionId} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return { scanned: rows.length, stopped, deleted, errors };
}
