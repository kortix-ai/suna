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
