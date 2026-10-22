/**
 * session-pages — the paged project session list.
 *
 * `GET /projects/:id/sessions` is a keyset page (50 rows by default, newest
 * activity first) with the next cursor in the `x-next-cursor` header
 * (`listProjectSessionsPage` in @kortix/sdk). The drawer and the Sessions page
 * walk it with `useInfiniteQuery` (`useProjectSessionsPaged`). These are the
 * pure pieces of that wiring, the same rules as the SDK's
 * `useProjectSessions` (`packages/sdk/src/react/use-project-sessions.ts`).
 * The hook reads past empty pages with the SDK's own
 * `shouldScanPastEmptySessionPages`.
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
 * - `more` — no session loaded yet, but a next page exists (KRTX-1727). The
 *   server drops rows the viewer may not see, and deleted ones, after a
 *   bounded scan, so a page can be empty and still carry a cursor. The list
 *   offers the next page, never "No sessions yet". A failed next page stays
 *   `more`: its Show more button is the retry.
 * - `empty` — the query succeeded with zero sessions and no next page.
 * - `rows` — at least one session loaded. A background poll or pull-refresh
 *   failure that still has rows counts as `rows`, not `error`: the failure
 *   never hides data the user already saw.
 */
export type SessionListState = 'loading' | 'error' | 'empty' | 'more' | 'rows';

export function sessionListState(state: {
  isPending: boolean;
  isError: boolean;
  hasSessions: boolean;
  /** A list has a next page (`hasNextPage`). */
  hasMore?: boolean;
}): SessionListState {
  if (state.isPending) return 'loading';
  if (state.hasSessions) return 'rows';
  if (state.hasMore) return 'more';
  return state.isError ? 'error' : 'empty';
}
