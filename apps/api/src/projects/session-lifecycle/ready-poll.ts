/**
 * HOW OFTEN THE DELIVERY LOOP RECHECKS THAT A RUNTIME IS READY.
 *
 * Kept in its own module rather than inline in `engine.ts` so it can be unit
 * tested without pulling in that file's import graph (config, db, billing,
 * connectors), which needs a live SUPABASE_URL and friends just to load — the
 * same reason `sandbox-deadline-policy.ts` and `agent-availability.ts` live
 * apart from their callers.
 *
 * The recheck was a flat 3 s, so a prompt queued while its runtime was still
 * provisioning waited on average half a poll after the runtime came up, for
 * nothing. Measured on dev 2026-09-08, one session split across three clocks
 * (client, the API's provision-timeline, and the cell's own turns table):
 *
 *   client: POST /sessions -> returns              1639 ms
 *   client: -> session reports ready               2861 ms
 *   cell:   ready -> prompt lands in the cell      1415 ms   <- this
 *   cell:   prompt lands -> turn starts               7 ms
 *   cell:   turn runs                              1547 ms
 *
 * 1415 ms of dead wait — longer than the model call it was waiting to make,
 * and two hundred times the cell's own share.
 */

/** The ceiling, and the grid. Unchanged from the flat interval it replaced: a
 *  Daytona box can take two minutes to boot and must not be polled hundreds of
 *  times. */
export const READY_POLL_MAX_MS = 3_000;
/** The first recheck. A cell reaches ready in about a second. */
export const READY_POLL_MIN_MS = 150;
const GROWTH = 1.8;

/**
 * The next recheck delay, given how long the loop has already waited and what
 * it slept last.
 *
 * Two properties, and the second is why `elapsedMs` is a parameter at all:
 *
 *   1. EARLY IS FAST. The first rechecks are ~150 ms, so a cell that is ready
 *      in a second is delivered to in a second.
 *   2. NEVER SLOWER THAN THE FLAT INTERVAL IT REPLACED. A flat 3 s notices
 *      anything ready in (0, 3000] at exactly t=3000. A naive geometric backoff
 *      does not: ticks at 1781 and 3356 make a runtime ready at 2000 ms wait
 *      LONGER than before (3356 vs 3000). Simulated before it shipped, which is
 *      the only reason it did not.
 *
 * So each sleep is clamped to land on the next multiple of READY_POLL_MAX_MS.
 * The 3 s grid is preserved exactly and subdivided, which makes "never worse"
 * true by construction rather than by hope.
 */
export function nextReadyPollMs(elapsedMs: number, previousMs: number): number {
  const grown =
    !Number.isFinite(previousMs) || previousMs <= 0
      ? READY_POLL_MIN_MS
      : Math.min(READY_POLL_MAX_MS, Math.round(previousMs * GROWTH));
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const nextBoundary = (Math.floor(elapsed / READY_POLL_MAX_MS) + 1) * READY_POLL_MAX_MS;
  return Math.max(1, Math.min(grown, nextBoundary - elapsed));
}
