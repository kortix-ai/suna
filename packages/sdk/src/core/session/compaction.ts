/**
 * Is this session COMPACTING? One pure projection, shaped like `working.ts`.
 *
 * Compaction is not a turn — `GET .../turn` reports nothing for it and the
 * working projection deliberately knows nothing about it — but the composer
 * still has to hold while it runs, so it had its own answer. That answer was a
 * client-only boolean set by `startCompaction` and cleared ONLY by the
 * `session.compacted` SSE frame: an unbounded latch on a signal that can be
 * lost, which is the same defect the working projection was built to end.
 *
 * Two honest inputs replace it:
 *
 *  - `serverCompactingAtMs` — `Session.time.compacting`, the runtime's own
 *    record, which nothing in this repo read before. It is what makes a
 *    compaction started by a second device or a trigger visible here at all.
 *  - `optimisticAtMs` — this tab's own `/compact`, which is accepted locally
 *    long before the row exists, and is therefore BOUNDED.
 */

/**
 * How long this tab's own `/compact` may claim `compacting` on its own.
 *
 * Generous next to a real compaction (a summarize call against the whole
 * transcript), and finite because the release signal is one SSE frame. Missing
 * that frame — a backgrounded tab, a stream reconnect — used to pin the
 * composer for the lifetime of the tab.
 */
export const OPTIMISTIC_COMPACTION_MAX_MS = 60_000;

export interface CompactionInputs {
  /** ms epoch at which this tab issued `/compact`, or null. */
  optimisticAtMs: number | null;
  /** `Session.time.compacting` from the runtime session row, or null. */
  serverCompactingAtMs: number | null;
  nowMs: number;
}

/**
 * Precedence, and there are only two rules:
 *
 *  1. The runtime says a compaction is open → compacting. It is an observation
 *     of the server's own row, so it is not bounded here; the row is cleared by
 *     the refetch `session.compacted` already triggers.
 *  2. Otherwise this tab's own unanswered `/compact`, until it ages out.
 */
export function projectCompacting(inputs: CompactionInputs): boolean {
  if (inputs.serverCompactingAtMs !== null) return true;
  if (inputs.optimisticAtMs === null) return false;
  return inputs.nowMs - inputs.optimisticAtMs < OPTIMISTIC_COMPACTION_MAX_MS;
}

/**
 * The next instant at which {@link projectCompacting} could answer differently
 * on its own — i.e. when the optimistic stamp ages out.
 *
 * The projection is pure and moves with `nowMs`, so something has to ask it
 * again at that instant or the cap is never applied. Nothing else re-renders
 * when a compaction quietly outlives its stamp: the store slot has not changed,
 * the transcript is idle, and the lost frame is precisely the case where no
 * further event arrives. Same mechanism, same reason, as `workingExpiryAtMs`.
 *
 * `null` when nothing is left to expire (deadlines already past are skipped, so
 * re-arming from what this returns terminates).
 */
export function compactionExpiryAtMs(inputs: CompactionInputs): number | null {
  if (inputs.serverCompactingAtMs !== null) return null;
  if (inputs.optimisticAtMs === null) return null;
  const deadline = inputs.optimisticAtMs + OPTIMISTIC_COMPACTION_MAX_MS;
  return deadline > inputs.nowMs ? deadline : null;
}

/**
 * How long a SERVER-observed `Session.time.compacting` may go unconfirmed
 * before the caller must force a fresh read instead of trusting the cached
 * row forever.
 *
 * Rule 1 of {@link projectCompacting} treats any non-null
 * `serverCompactingAtMs` as authoritative for as long as it is observed — by
 * design, since it is the runtime's own record, not a guess, and
 * {@link compactionExpiryAtMs} deliberately arms no timer for it. But the
 * only event that is SUPPOSED to clear that cached row
 * (`session.compacted`, handled in `use-opencode-events/handle-event.ts`) can
 * be lost the exact same way any SSE frame can — a backgrounded tab, a
 * stream reconnect — and the targeted refetch that handler fires is its own
 * network call that can itself fail. `useOpenCodeSession`
 * (`use-opencode-sessions/sessions.ts`) reads the row with
 * `staleTime: Infinity` and nothing else ever refetches it, so without a
 * ceiling here "authoritative" becomes "wedged for the tab's lifetime" the
 * moment either of those is lost — reproducing the exact unbounded-latch
 * class this module exists to end.
 *
 * This is that ceiling. It does not change `projectCompacting`'s answer —
 * rule 1 stays authoritative right up to the deadline — it only tells the
 * caller (`use-session.ts`) WHEN to stop trusting the cached row and ask the
 * server again, independent of whether `session.compacted` ever arrives.
 */
export const SERVER_COMPACTION_REVALIDATE_MS = 90_000;

/**
 * The next instant at which a server-observed compaction flag needs a live
 * re-check (see {@link SERVER_COMPACTION_REVALIDATE_MS}), or `null` when no
 * server flag is currently observed.
 *
 * Unlike {@link compactionExpiryAtMs}, this CAN return an instant already in
 * the past: the deadline is anchored to `serverCompactingAtMs` (when the flag
 * was FIRST observed), not to `nowMs`, so a session mounted well after
 * compaction started — or one whose revalidation kept re-arming because the
 * server kept confirming `compacting: true` — can already be overdue the
 * moment this is read. The caller fires the re-check immediately in that
 * case rather than skip it: a stale flag discovered late is still stale.
 */
export function serverCompactionRevalidateAtMs(inputs: CompactionInputs): number | null {
  if (inputs.serverCompactingAtMs === null) return null;
  return inputs.serverCompactingAtMs + SERVER_COMPACTION_REVALIDATE_MS;
}
