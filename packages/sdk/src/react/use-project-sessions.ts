/**
 * The project session list, paged.
 *
 * `GET /projects/:id/sessions` used to answer with every session row the viewer
 * could see. On a project that had accumulated 12,617 sessions that is a
 * multi-megabyte body — and the sidebar re-fetches this list every 5 seconds
 * for as long as ANY one row sits in `queued`/`branching`/`provisioning`, which
 * over twelve thousand rows is effectively always. The browser paid three times
 * per tick: parsing the body, letting react-query structurally share 12k
 * objects, then re-sorting and re-grouping them into sections.
 *
 * The list is now a bounded keyset page (`listProjectSessionsPage`). This module
 * holds the two pure pieces of the `useInfiniteQuery` wiring so they can be
 * tested without mounting react-query, plus the hook itself.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  listProjectSessionsPage,
  type ListProjectSessionsOptions,
  type ProjectSession,
  type ProjectSessionPage,
} from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';
import { contract } from './query-contracts';

/**
 * `getNextPageParam`. Returns `undefined` — not `null` — at the end of the
 * list: `undefined` is what react-query reads as "no more pages", and it is
 * what makes `hasNextPage` go false. Handing back `null` leaves `hasNextPage`
 * true and a Load-more button that re-fetches page one forever.
 */
export function projectSessionsPageParam(page: ProjectSessionPage): string | undefined {
  return page.next_cursor ?? undefined;
}

/**
 * Flatten the fetched pages into the flat array every consumer of this list
 * already renders.
 *
 * De-duplicates by `session_id`, keeping first occurrence. A session prompted
 * between two page fetches moves to the top of the `updated_at DESC` order, so
 * a row already served on page 1 legitimately reappears on page 2 — keyset
 * paging makes that a shifted window, not a bug to fix server-side. Rendering
 * it twice would hand React two children with the same key.
 */
export function flattenProjectSessionPages(
  data: { pages: ProjectSessionPage[]; pageParams: unknown[] } | undefined,
): ProjectSession[] {
  if (!data) return [];
  const seen = new Set<string>();
  const flat: ProjectSession[] = [];
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
 * How many pages the list reads on its own while every page so far was empty.
 * Each server page scans a bounded number of rows, so 5 pages cover about
 * 2,400 newer rows the viewer cannot see. Past that, the viewer presses
 * Load more.
 */
export const EMPTY_SESSION_PAGE_SCAN_LIMIT = 5;

/**
 * Whether to read the next page on its own (KRTX-1727). The server drops rows
 * the viewer may not see, and deleted ones, after a bounded scan, so a page
 * can be empty and still carry a cursor. That is not an empty list.
 */
export function shouldScanPastEmptySessionPages(
  data: { pages: ProjectSessionPage[]; pageParams: unknown[] } | undefined,
  hasNextPage: boolean,
): boolean {
  if (!data || !hasNextPage) return false;
  if (data.pages.length >= EMPTY_SESSION_PAGE_SCAN_LIMIT) return false;
  return data.pages.every((page) => page.items.length === 0);
}

export interface UseProjectSessionsOptions
  extends Pick<ListProjectSessionsOptions, 'scope' | 'limit' | 'parent' | 'startedBy' | 'q' | 'labels'> {
  enabled?: boolean;
  /** Milliseconds, or false. Evaluated against the sessions loaded SO FAR. */
  refetchInterval?: number | false | ((sessions: ProjectSession[]) => number | false);
  refetchOnWindowFocus?: boolean;
}

/**
 * One project's sessions, newest activity first, fetched a page at a time.
 *
 * Returns the flat `sessions` array plus the paging controls, so a list that
 * previously read `data ?? []` changes only where the array comes from.
 */
export function useProjectSessions(projectId: string, options?: UseProjectSessionsOptions) {
  const scope = options?.scope ?? 'visible';
  const { parent, startedBy, q, labels } = options ?? {};
  const query = useInfiniteQuery({
    queryKey: qk.project.sessionsPaged(projectId, scope, { parent, startedBy, q, labels }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listProjectSessionsPage(projectId, {
        scope,
        limit: options?.limit,
        cursor: pageParam,
        parent,
        startedBy,
        q,
        labels,
      }),
    getNextPageParam: projectSessionsPageParam,
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    ...contract('inventory'),
    refetchInterval: (query) => {
      const interval = options?.refetchInterval;
      if (typeof interval !== 'function') return interval ?? false;
      return interval(flattenProjectSessionPages(query.state.data));
    },
  });

  const isScanning = shouldScanPastEmptySessionPages(query.data, query.hasNextPage);
  const { isFetching, fetchNextPage } = query;
  useEffect(() => {
    if (isScanning && !isFetching) void fetchNextPage();
  }, [isScanning, isFetching, fetchNextPage]);

  return {
    ...query,
    /**
     * True while every page so far was empty and the list reads the next one
     * on its own. Render it as loading, never as "no sessions".
     */
    isScanning,
    /**
     * Every page loaded so far, flattened and de-duplicated.
     *
     * A poll refetches EVERY loaded page, so a viewer who has pressed
     * "Load more" several times pays for each of them on every tick. That is
     * the intended trade — it is bounded by what the viewer actually asked to
     * see, where the old behavior was bounded by nothing.
     */
    sessions: flattenProjectSessionPages(query.data),
  };
}

export interface UseSessionChildrenOptions extends Pick<ListProjectSessionsOptions, 'limit' | 'q'> {
  /** Set false until the parent is expanded — children load lazily. */
  enabled?: boolean;
}

/**
 * One session's children (`parent=<sessionId>`), newest first, a page at a
 * time. Its own cache slot per (parent, q), so an expanded row and a search
 * never share entries.
 */
export function useSessionChildren(
  projectId: string,
  parentSessionId: string,
  options?: UseSessionChildrenOptions,
) {
  const q = options?.q;
  const query = useInfiniteQuery({
    queryKey: qk.project.sessionChildren(projectId, parentSessionId, q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listProjectSessionsPage(projectId, {
        parent: parentSessionId,
        limit: options?.limit,
        cursor: pageParam,
        q,
      }),
    getNextPageParam: projectSessionsPageParam,
    enabled: options?.enabled ?? true,
    ...contract('inventory'),
  });
  return { ...query, sessions: flattenProjectSessionPages(query.data) };
}
