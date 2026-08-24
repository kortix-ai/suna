/**
 * WHY a sandbox parked. Written to `session_sandboxes.metadata.stopReason` by
 * every path that stops a box, and read by the path-classification query.
 *
 * CLOSED on purpose. The classification query groups on this value, so a
 * free-text reason does not produce a wrong answer — it produces a quietly
 * incomplete one, which is worse.
 *
 * The catalogue itself now lives in `@kortix/api-contract` because the value
 * is serialized to clients (`ProjectSessionSandbox.stop_reason`). It is
 * re-exported here so every existing server import keeps working and there is
 * still exactly one list. The notes below stay here: they are about what this
 * server does and does not write, which is not the wire's business.
 */
import { STOP_REASONS, type StopReason } from '@kortix/api-contract';

// Re-exported, not redeclared: `isStopReason` and `STOP_REASONS_NOT_YET_EMITTED`
// below need them in local scope too, which a bare `export ... from` does not give.
export { STOP_REASONS, type StopReason };


/**
 * Members that NO code path writes today. Read this before reading a zero.
 *
 * The classification query groups on `stopReason`, so a member nobody emits
 * comes back with 0 rows — indistinguishable from "measured, and it never
 * happens". That is the same confident-wrong failure as stamping the wrong
 * reason, just quieter, so the gap is declared here rather than left for the
 * query's author to discover.
 *
 * WHY they are not emitted: every deadline park goes through `stopExpiredBox`,
 * which fires on the single comparison `deadline_at <= now`. The row carries
 * `deadline_at` and nothing else — the writers in ./sandbox-deadline.ts only
 * move that timestamp, and never record WHICH grant last moved it. So at stop
 * time a deadline pulled in by a terminal turn end (`idle_grace`) is byte-
 * identical to one left by the 20-minute boot floor or a 4-hour turn grant.
 * Reconstructing the difference from the timestamp alone would be a guess
 * dressed as a measurement, which is exactly what this field exists to stop.
 *
 * Emitting them honestly means persisting the grant kind at the moment the
 * deadline is written, then passing it into `stopExpiredBox`. That is a change
 * to the deadline writers, not to the stop path, and it is deliberately not in
 * this change.
 */
export const STOP_REASONS_NOT_YET_EMITTED = ['idle_grace', 'boot_floor_expired'] as const satisfies
  readonly StopReason[];

export function isStopReason(value: unknown): value is StopReason {
  return typeof value === 'string' && (STOP_REASONS as readonly string[]).includes(value);
}
