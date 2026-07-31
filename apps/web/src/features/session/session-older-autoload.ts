/** State the top-of-transcript sentinel decides on. */
export interface OlderHistoryAutoloadState {
  /** The sentinel is within `rootMargin` of the transcript scroll root. */
  isIntersecting: boolean;
  /** The sync engine still holds a cursor for older messages. */
  hasOlder: boolean;
  /** A pull is already in flight. */
  isLoadingOlder: boolean;
  /** The last pull rejected. Re-arming on failure would spin. */
  lastPullFailed: boolean;
}

/** Decides whether the top sentinel coming into view should pull the previous
 *  page of history — the transcript equivalent of
 *  `shouldFetchNextMarketplacePage`, extracted for the same reason: the paging
 *  decision is then unit-testable without a real `IntersectionObserver`.
 *
 *  `lastPullFailed` is the one condition the old manual button gave us for
 *  free. An observer re-arms whenever its dependencies change, so a cursor the
 *  runtime keeps rejecting would otherwise become an unbounded retry loop;
 *  after a failure the transcript falls back to an explicit retry affordance. */
export function shouldLoadOlderHistory(state: OlderHistoryAutoloadState): boolean {
  return state.isIntersecting && state.hasOlder && !state.isLoadingOlder && !state.lastPullFailed;
}
