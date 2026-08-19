/**
 * How the catalogue reaches past its first page.
 *
 * **One mechanism.** Reaching the foot of the grid — by scrolling to the
 * sentinel or by pressing the button beside it — fetches the next page. There
 * is no ceiling, because reaching the foot is an explicit request for more.
 *
 * This module used to hold three more mechanisms: `CATALOG_INITIAL_PAGES` (four
 * pages fetched eagerly on every load), `CATALOG_FOCUS_TARGET` /
 * `CATALOG_AUTOLOAD_MAX_PAGES` (an effect chain that kept fetching while a
 * client-side category bucket looked thin), and `CATALOG_REVEAL_STEP` /
 * `CATALOG_INITIAL_REVEAL` (a reveal window layered over the flat grid). All
 * three existed for one reason: the client had to accumulate enough pages to
 * fake a category filter the API could not perform. They are gone because the
 * server performs it now — see `apps/api/src/connectors/pipedream-index.ts`.
 *
 * They were also the reported jank. Eager paging plus in-place section growth
 * meant the browse page reflowed under the reader on every landed page, and the
 * reveal window meant a scroll sometimes uncovered cards and sometimes fetched
 * them, with no way for the user to tell which.
 *
 * `shouldLoadOnScroll` is a pure predicate so the paging decision is testable
 * without a real `IntersectionObserver`, react-query, or a DOM. Same split as
 * `marketplace-grid.ts:shouldFetchNextMarketplacePage`.
 */

/**
 * Whether the bottom sentinel coming into view should fetch the next page.
 *
 * The only guards are "there is more" and "one is not already in flight".
 */
export function shouldLoadOnScroll(
  isIntersecting: boolean,
  query: { hasMore: boolean; isLoadingMore: boolean },
): boolean {
  return isIntersecting && query.hasMore && !query.isLoadingMore;
}
