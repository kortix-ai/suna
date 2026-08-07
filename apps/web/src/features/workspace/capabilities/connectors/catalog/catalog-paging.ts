/**
 * How the catalogue reaches past its first page.
 *
 * Two mechanisms, deliberately separate, because they answer to different
 * authorities:
 *
 *   - **Automatic depth** (`shouldAutoLoadPage`) is work the page does without
 *     being asked. It is capped, because nothing the user did justifies walking
 *     a 5,758-item catalogue.
 *   - **Scroll depth** (`shouldLoadOnScroll`) is work the user asked for by
 *     scrolling to the bottom of what is on screen. It is NOT capped — reaching
 *     the foot of the grid is an explicit request for more, and answering it
 *     with a ceiling is the regression this module exists to undo.
 *
 * Both are pure predicates so the paging decision is testable without a real
 * `IntersectionObserver`, react-query, or a DOM. Same split as
 * `marketplace-grid.ts:shouldFetchNextMarketplacePage`, which is the existing
 * precedent for infinite scroll in this app.
 */

/**
 * Pages fetched eagerly on every load, including the first.
 *
 * One page is 48 apps (`apps/api/src/connectors/pipedream.ts:349`). Four is
 * ~192, which spreads across ~11 category sections with enough left over that
 * the large ones open with real depth rather than a handful of cards.
 *
 * This is the first-paint budget only. It used to be the entire ceiling.
 */
export const CATALOG_INITIAL_PAGES = 4;

/**
 * How many entries a focused category should hold before automatic deepening
 * stops and scrolling takes over.
 *
 * 24 is four rows of the widest grid (`xl:grid-cols-3`) — past the fold on a
 * laptop, so the user has something to scroll before the sentinel fires and
 * the grid never lands in the state where "all of Finance" is eight cards.
 */
export const CATALOG_FOCUS_TARGET = 24;

/**
 * The ceiling on **unattended** paging: ~1,150 apps.
 *
 * Reached only by a focused category too rare to hit `CATALOG_FOCUS_TARGET`
 * within it. Without a ceiling, picking a category with 3 apps in the whole
 * catalogue would walk all ~120 pages on its own, at one request each, because
 * every landing page would leave the target unmet.
 *
 * A ceiling on automatic work is not a ceiling on the catalogue. Past it the
 * scroll sentinel keeps going for as long as the user keeps scrolling.
 */
export const CATALOG_AUTOLOAD_MAX_PAGES = 24;

/**
 * Cards uncovered per scroll, once the data is already in hand.
 *
 * **This is a reveal step, not a page size.** One request is 48 apps
 * (`apps/api/src/connectors/pipedream.ts:349`) and that stays: asking the API
 * for 6 at a time would turn a 2,713-item catalogue into ~450 round trips, each
 * with its own latency, to render the same grid. So the network keeps fetching
 * in 48s and the GRID uncovers what it holds in 6s — two rows of the widest
 * layout (`xl:grid-cols-3`).
 *
 * The result is that the grid grows by a couple of rows as you scroll instead
 * of jumping by 48 whenever a request lands, and most of those growth steps
 * cost nothing at all because the cards are already loaded.
 */
export const CATALOG_REVEAL_STEP = 6;

/**
 * Cards shown before the user scrolls at all.
 *
 * 24 is eight rows at `xl:grid-cols-3`, which is past the fold on a laptop —
 * enough that the first thing the user does is scroll, not wait. Below that the
 * sentinel sits on screen at rest and the grid fills itself while nobody has
 * asked it to.
 */
export const CATALOG_INITIAL_REVEAL = 24;

/** Whether more of what is ALREADY loaded is still hidden behind the reveal
 *  window. Checked before the network is: uncovering costs nothing, so it is
 *  always the cheaper way to answer a scroll. */
export function canRevealMore(revealed: number, loaded: number): boolean {
  return revealed < loaded;
}

/** The next reveal window, clamped so it never claims more than is loaded. */
export function nextRevealCount(revealed: number, loaded: number): number {
  return Math.min(revealed + CATALOG_REVEAL_STEP, loaded);
}

export interface CatalogPagingState {
  /** Whether the catalogue is on screen at all. */
  enabled: boolean;
  /** Pages already landed for the CURRENT query key. */
  loadedPages: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /**
   * Whether react-query is showing the previous query's data.
   *
   * Load-bearing, not defensive. While `placeholderData` is on screen,
   * `loadedPages` and `hasNextPage` describe the PREVIOUS query — paging off
   * them fires a cursor request against a query whose first page has not
   * landed.
   */
  isPlaceholderData: boolean;
  /**
   * The category the user is looking at, and how much of it is loaded. `null`
   * when browsing everything, where `CATALOG_INITIAL_PAGES` is the whole
   * automatic budget.
   */
  focus: { loaded: number; target: number } | null;
  initialPages: number;
  maxPages: number;
}

/**
 * Whether to pull one more page in the background.
 *
 * `loadedPages > 0` is what keeps this from racing the first request:
 * react-query reports `hasNextPage` false while a fresh infinite query is
 * pending, but that is also true of a genuinely exhausted one, so firing before
 * page 1 lands would start a second request against the same cursor.
 */
export function shouldAutoLoadPage(state: CatalogPagingState): boolean {
  if (!state.enabled) return false;
  if (state.isPlaceholderData) return false;
  if (state.loadedPages <= 0) return false;
  if (!state.hasNextPage) return false;
  if (state.isFetchingNextPage) return false;
  if (state.loadedPages >= state.maxPages) return false;
  if (state.loadedPages < state.initialPages) return true;
  // Past the first-paint budget, only a focused category still justifies
  // fetching on its own: the grid is a client-side slice of the loaded pages,
  // so a thin category is thin because of what has been loaded, not because
  // that is all the catalogue has.
  return state.focus !== null && state.focus.loaded < state.focus.target;
}

/**
 * Whether the bottom sentinel coming into view should fetch the next page.
 *
 * No page ceiling here, on purpose — see the module doc. The only guards are
 * "there is more" and "one is not already in flight".
 */
export function shouldLoadOnScroll(
  isIntersecting: boolean,
  query: { hasMore: boolean; isLoadingMore: boolean },
): boolean {
  return isIntersecting && query.hasMore && !query.isLoadingMore;
}
