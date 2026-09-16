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

export interface UseProjectSessionsOptions
  extends Pick<ListProjectSessionsOptions, 'scope' | 'limit'> {
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
  const query = useInfiniteQuery({
    queryKey: qk.project.sessionsPaged(projectId, scope),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listProjectSessionsPage(projectId, {
        scope,
        limit: options?.limit,
        cursor: pageParam,
      }),
    getNextPageParam: projectSessionsPageParam,
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    refetchInterval: (query) => {
      const interval = options?.refetchInterval;
      if (typeof interval !== 'function') return interval ?? false;
      return interval(flattenProjectSessionPages(query.state.data));
    },
    ...contract('inventory'),
  });

  return {
    ...query,
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
