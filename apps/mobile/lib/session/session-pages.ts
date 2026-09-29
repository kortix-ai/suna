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

import { sessionParentId } from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';

import { groupSessionsByCoordinator, sessionLastActivityAt } from './session-list';

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

/**
 * The server's keyset position after the loaded pages: the oldest
 * `updated_at` on the last page that has rows. A coordinator the API appends
 * to a page (the parent of a row on it) rides outside the keyset, so it does
 * not count.
 */
function loadedBoundaryMs(pages: SessionPage<ProjectSession>[]): number | null {
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    const items = pages[i].items;
    const parents = new Set(items.map((session) => sessionParentId(session)));
    let boundary = Infinity;
    for (const session of items) {
      if (parents.has(session.session_id)) continue;
      const updatedAt = Date.parse(session.updated_at);
      if (updatedAt < boundary) boundary = updatedAt;
    }
    if (boundary !== Infinity) return boundary;
  }
  return null;
}

/**
 * The loaded sessions whose place in the list is final.
 *
 * The API pages by `updated_at`; the drawer and the Sessions page sort by
 * last activity (`sessionLastActivityAt`), which is never later than
 * `updated_at`. A session updated today but last prompted in June is on page
 * one, yet every row of page two sorts above it. Shown at once, it sat at the
 * bottom of the list: each loaded page landed above it, the bottom never
 * changed, and scrolling down looked like no page ever loaded.
 *
 * So a session shows once its activity is at or after the loaded boundary:
 * no unloaded row can sort above it any more. The rest wait for a later page.
 * A coordinator group shows whole when any member shows.
 */
export function listedSessions(
  data: { pages: SessionPage<ProjectSession>[] } | undefined,
  hasNextPage: boolean
): ProjectSession[] {
  const loaded = flattenSessionPages(data);
  const boundary = hasNextPage && data ? loadedBoundaryMs(data.pages) : null;
  if (boundary === null) return loaded;
  const listed = new Set<string>();
  for (const group of groupSessionsByCoordinator(loaded)) {
    const members = [group.session, ...group.children];
    if (!members.some((session) => sessionLastActivityAt(session) >= boundary)) continue;
    for (const session of members) listed.add(session.session_id);
  }
  // ponytail: when every loaded row waits, show them all rather than an empty
  // list that reads as "No sessions yet"; their order may shift as pages land.
  return listed.size > 0 ? loaded.filter((session) => listed.has(session.session_id)) : loaded;
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
