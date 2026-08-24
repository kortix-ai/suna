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
  /** Pages this session has already pulled AUTOMATICALLY. Absent counts as
   *  none — a fresh session, not an exhausted one. */
  autoLoadedPages?: number;
  /**
   * The reader has scrolled the transcript UP at least once.
   *
   * Without this the sentinel fired on mount: with the first page smaller than
   * the viewport its top edge is inside the 400px margin before anyone
   * touches anything, so a session open cost three reads instead of one
   * (`message?limit=20` + two `before=` pages, measured on a real session).
   * History is pulled when a reader reaches for it, not because the page is
   * short. Absent counts as "not yet".
   */
  readerScrolledUp?: boolean;
}

/**
 * How many pages the sentinel may pull on its own before a reader has to ask.
 *
 * A transcript never sheds what it pulls: the turns stay in the DOM, their parts
 * stay in the sync store, and every image keeps a decoded bitmap alive — a
 * session page unmounts nothing. Uncapped, idle scrolling walks a long thread's
 * entire history into memory, which is the retention behind a tab the browser
 * discards and reloads by itself.
 *
 * Four pages on top of the first is 250 messages — past any conversation a
 * reader scrolls through without meaning to, and far short of the sizes where
 * the page starts to hurt. Reading further back is still one click away; it
 * just stops being something a scroll does by accident.
 */
export const OLDER_AUTOLOAD_MAX_PAGES = 4;

/** The sentinel has spent its budget and the reader must ask for more. Drives
 *  the manual control; never blocks an explicit pull. */
export function olderAutoloadExhausted(state: {
  hasOlder: boolean;
  autoLoadedPages?: number;
}): boolean {
  return state.hasOlder && (state.autoLoadedPages ?? 0) >= OLDER_AUTOLOAD_MAX_PAGES;
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
  return (
    state.readerScrolledUp === true &&
    state.isIntersecting &&
    state.hasOlder &&
    !state.isLoadingOlder &&
    !state.lastPullFailed &&
    !olderAutoloadExhausted(state)
  );
}
