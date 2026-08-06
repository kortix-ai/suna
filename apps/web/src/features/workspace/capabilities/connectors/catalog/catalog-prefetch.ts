/**
 * How many pages of the catalogue to hold, including the first.
 *
 * One page is 48 apps (`apps/api/src/connectors/pipedream.ts:349`), which spread
 * across ~11 category sections leaves several of them with a handful of cards
 * — "View all" on Productivity opened 8. Four pages is ~192 apps, enough for
 * 25-40 in the large categories.
 *
 * A page COUNT, not a scroll position or an item target: it is the same four
 * requests on every load, it cannot run away on a 5,758-item catalogue, and
 * raising the depth is one number.
 */
export const CATALOG_PREFETCH_PAGES = 4;

/**
 * Whether to pull one more page in the background.
 *
 * This is not pagination and must not become it. There is no control, no
 * spinner and no scroll trigger — the grid paints from page 1 and the later
 * pages arrive underneath it, so sections grow taller without anything moving
 * under the pointer.
 *
 * `loadedPages > 0` is what keeps it from racing the first request: react-query
 * reports `hasNextPage` false while a fresh infinite query is still pending, but
 * that is also true of a genuinely exhausted one, and firing before page 1
 * lands would start a second request against the same cursor.
 */
export function shouldPrefetchMorePages(state: {
  loadedPages: number;
  maxPages: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}): boolean {
  return (
    state.loadedPages > 0 &&
    state.loadedPages < state.maxPages &&
    state.hasNextPage &&
    !state.isFetchingNextPage
  );
}
