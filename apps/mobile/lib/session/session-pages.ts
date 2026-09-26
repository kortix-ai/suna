/**
 * session-pages — the paged project session list.
 *
 * `GET /projects/:id/sessions` is a keyset page (50 rows by default, newest
 * activity first) with the next cursor in the `x-next-cursor` header
 * (`listProjectSessionsPage` in @kortix/sdk). The drawer and the Sessions page
 * walk it with `useInfiniteQuery` (`useProjectSessionsPaged`). These are the
 * pure pieces of that wiring, the same rules as the SDK's web hook
 * (`packages/sdk/src/react/use-project-sessions.ts`), which this app cannot
 * import: `@kortix/sdk/react` is web's React surface.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */

export interface SessionPage<T> {
  items: T[];
  /** Null on the last page. */
  next_cursor: string | null;
}

/**
 * `getNextPageParam`. `undefined`, not `null`, ends the list: react-query
 * reads only `undefined` as "no more pages". Null would leave `hasNextPage`
 * true and refetch page one forever.
 */
export function sessionsNextCursor(page: SessionPage<unknown>): string | undefined {
  return page.next_cursor ?? undefined;
}

/**
 * Every loaded page as one list, de-duplicated by `session_id` (first wins).
 * A session prompted between two page fetches moves to the top of the order,
 * so page 2 can repeat a row of page 1. Rendering it twice would give the
 * list two rows with one key.
 */
export function flattenSessionPages<T extends { session_id: string }>(
  data: { pages: SessionPage<T>[] } | undefined,
): T[] {
  if (!data) return [];
  const seen = new Set<string>();
  const flat: T[] = [];
  for (const page of data.pages) {
    for (const session of page.items) {
      if (seen.has(session.session_id)) continue;
      seen.add(session.session_id);
      flat.push(session);
    }
  }
  return flat;
}

/** `onEndReached` fires repeatedly near the end of a list: fetch one page at a time. */
export function shouldLoadMoreSessions(state: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isRefreshing: boolean;
}): boolean {
  return state.hasNextPage && !state.isFetchingNextPage && !state.isRefreshing;
}

/**
 * A filter with fewer matches than this over the loaded pages keeps loading
 * older pages on its own: about one screen of rows.
 */
export const FILTER_AUTO_FETCH_MIN_MATCHES = 20;

/**
 * KRTX-250: whether a filtered list loads its next page without a scroll.
 * `onEndReached` alone strands a filter: while the filtered list stays empty
 * (or short) its content size never changes, so FlatList stops calling it and
 * "No matching sessions" shows while unfetched pages hold matches. The page
 * runs this from an effect on every change instead. It stops at one screen of
 * matches (scrolling loads the rest), when the pages run out, and after a
 * failed page fetch (a scroll or a pull retries), so a failure never loops.
 */
export function shouldAutoFetchForFilter(state: {
  filterActive: boolean;
  matchCount: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isRefreshing: boolean;
  fetchNextPageFailed: boolean;
}): boolean {
  return (
    state.filterActive &&
    state.matchCount < FILTER_AUTO_FETCH_MIN_MATCHES &&
    !state.fetchNextPageFailed &&
    shouldLoadMoreSessions(state)
  );
}

/**
 * Which state a paged session list shows (COR-146: a failure must never look
 * like an empty list; a list not loaded yet must never look empty either).
 * The drawer's session list and the Sessions page share this decision so they
 * never drift apart:
 *
 * - `loading` — no page has loaded yet (`isPending`, react-query's
 *   `status: 'pending'`): the first fetch runs, retries, or waits for the
 *   network. Not `isLoading`: offline, react-query pauses the first fetch
 *   (`fetchStatus: 'paused'`, `isLoading` false), and the drawer and the
 *   Sessions page showed "No sessions yet" — the Sessions page then cleared
 *   the saved search and filter of a project that has sessions.
 * - `error` — the query failed and no session survived (nothing loaded
 *   before the failure, or a refetch failed with nothing cached).
 * - `empty` — the query succeeded with zero sessions.
 * - `rows` — at least one session loaded. A background poll or pull-refresh
 *   failure that still has rows counts as `rows`, not `error`: the failure
 *   never hides data the user already saw.
 */
export type SessionListState = 'loading' | 'error' | 'empty' | 'rows';

export function sessionListState(state: {
  isPending: boolean;
  isError: boolean;
  hasSessions: boolean;
}): SessionListState {
  if (state.isPending) return 'loading';
  if (state.hasSessions) return 'rows';
  return state.isError ? 'error' : 'empty';
}
