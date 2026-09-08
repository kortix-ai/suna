/**
 * STOPPING A BOX THAT SOMEBODY ELSE IS STILL USING.
 *
 * A cell sandbox can carry many sessions: celld holds many named isolates in
 * one node, each with its own SQLite, which is the isolation a session needs
 * (see platform/services/cell-host-platinum.ts). That is worth a lot — measured
 * on dev 2026-09-07, a session on a sandbox that already exists costs 194 ms
 * cold against 2443 ms for one that boots its own, and 2 ms per request after.
 * Re-measured 2026-09-08: creating an isolate on a live node is 65 ms p50 and
 * routing to one that exists is 1 ms, while the sandbox around it is ~1074 ms
 * of microVM before anything can answer.
 *
 * The reaper is what stopped that being turned on. It stops a box when THE
 * SESSION it is reaping is done, and a shared box is still somebody else's
 * runtime. `KORTIX_CELL_SHARED_HOST_ENABLED` says so in as many words: "the
 * reaper stops a box when its session is finished and nothing yet teaches it
 * that a host is shared."
 *
 * This is that teaching, and the signal needs no new bookkeeping: another
 * ACTIVE sandbox row pointing at the same `external_id` means stopping this box
 * powers off a session that is not being reaped. Two sessions never share an
 * external id unless a shared host put them there, so for every ordinary box
 * the count is zero and nothing about reaping changes.
 */

export type SharedBoxStopDecision =
  /** Nobody else is on this box: stop it, as the reaper always has. */
  | 'stop_the_box'
  /** Somebody else is: retire this session's row and leave the box running. */
  | 'release_this_session_only';

/**
 * Pure, so both branches are asserted rather than reproduced with a live
 * reaper, a provider and two sessions.
 *
 * Deliberately counts only sessions OTHER than the one being reaped, and only
 * ACTIVE ones — a row already stopped or failed is not somebody's runtime, and
 * counting it would strand a shared box forever after its last real user left.
 */
export function decideSharedBoxStop(otherActiveSessionsOnBox: number): SharedBoxStopDecision {
  return Number.isFinite(otherActiveSessionsOnBox) && otherActiveSessionsOnBox > 0
    ? 'release_this_session_only'
    : 'stop_the_box';
}
