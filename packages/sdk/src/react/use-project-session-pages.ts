'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  listProjectSessionsPage,
  type ProjectSession,
  type ProjectSessionPage,
} from '../core/rest/projects-client';

import {
  findCachedProjectSession,
  flattenProjectSessionPages,
  mergeProjectSessionHeadPage,
  type ProjectSessionPagesData,
} from './project-session-pages';
import { contract } from './query-contracts';
import { qk } from './query-keys';
import { useProjectSession } from './use-project-session';

export const PROJECT_SESSION_PAGE_SIZE = 50;

export interface UseProjectSessionPagesOptions {
  /** `'project'` is the manager-only inventory. Defaults to `'visible'`. */
  scope?: 'visible' | 'project';
  /** Sessions per page, 1–200. Part of the cache key. Defaults to 50. */
  pageSize?: number;
  enabled?: boolean;
  /**
   * Poll policy, decided from the sessions loaded so far. A poll fetches page
   * 1 only and merges it into the loaded pages.
   */
  refetchInterval?: (sessions: ProjectSession[]) => number | false;
  /** Refetch page 1 (not every loaded page) when the window regains focus. */
  refetchOnWindowFocus?: boolean;
}

/**
 * A project's sessions as an infinite list: one page on mount,
 * `fetchNextPage()` for the next.
 *
 * `data` is the flattened, de-duplicated session array (see
 * `flattenProjectSessionPages`). `hasNextPage`, `fetchNextPage` and
 * `isFetchingNextPage` are TanStack's own. Rendering every session of a large
 * project is what this replaces — `listProjectSessions` returns the whole
 * inventory in one response.
 *
 * **Polling and focus refetch fetch page 1 only.** A TanStack infinite-query
 * refetch re-requests every loaded page in order, so a list scrolled 240 pages
 * deep issued 240 requests per poll. The infinite query never polls; a head
 * query for page 1 does, and `mergeProjectSessionHeadPage` folds it into the
 * loaded pages. The head is seeded from the loaded page 1, so mounting it
 * issues no request. Explicit invalidation (create, rename, delete) still
 * refetches the loaded pages, as TanStack defines.
 */
export function useProjectSessionPages(
  projectId: string | undefined,
  options?: UseProjectSessionPagesOptions,
) {
  const queryClient = useQueryClient();
  const scope = options?.scope ?? 'visible';
  const pageSize = options?.pageSize ?? PROJECT_SESSION_PAGE_SIZE;
  const enabled = Boolean(projectId) && (options?.enabled ?? true);
  const refetchInterval = options?.refetchInterval;
  const queryKey = qk.project.sessionPages(projectId ?? '', scope, pageSize);

  const pages = useInfiniteQuery({
    ...contract('inventory'),
    queryKey,
    queryFn: ({ pageParam }): Promise<ProjectSessionPage> =>
      listProjectSessionsPage(projectId as string, {
        scope,
        limit: pageSize,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    select: flattenProjectSessionPages,
    enabled,
    // A mount (the Sessions page opening beside the sidebar) and a focus must
    // not re-request every loaded page. The head query below refetches page 1
    // on both and merges it.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const head = useQuery({
    ...contract('inventory'),
    queryKey: [...queryKey, 'head'] as const,
    queryFn: () => listProjectSessionsPage(projectId as string, { scope, limit: pageSize }),
    enabled: enabled && pages.isSuccess,
    initialData: () => queryClient.getQueryData<ProjectSessionPagesData>(queryKey)?.pages[0],
    initialDataUpdatedAt: () => queryClient.getQueryState(queryKey)?.dataUpdatedAt,
    refetchInterval: refetchInterval
      ? () =>
          refetchInterval(
            flattenProjectSessionPages(queryClient.getQueryData<ProjectSessionPagesData>(queryKey)),
          )
      : false,
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
  });

  const headData = head.data;
  useEffect(() => {
    if (!enabled || !headData) return;
    const current = queryClient.getQueryData<ProjectSessionPagesData>(queryKey);
    const merged = mergeProjectSessionHeadPage(current, headData);
    if (merged === 'refetch') {
      void queryClient.refetchQueries({ queryKey, exact: true });
    } else if (merged && merged !== current) {
      queryClient.setQueryData<ProjectSessionPagesData>(queryKey, merged);
    }
    // `queryKey` is rebuilt every render; its content is scope + size + id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headData, enabled, queryClient, projectId, scope, pageSize]);

  return pages;
}

/**
 * One session's row: the copy a loaded session list already holds, else the
 * single-session read.
 *
 * Replaces `listProjectSessions(...).find(...)`, which downloaded a project's
 * whole inventory to read one row. A session near the top of the list is
 * already on the sidebar's first page, so it resolves with no request, and
 * the list's own polls keep it fresh. A session on no loaded page falls back
 * to `useProjectSession` (`GET /sessions/:id`), which is enabled only while
 * no list holds the row.
 *
 * The list row omits write-only heavy metadata (`initial_prompt`,
 * `payload_summary`, …). Read `useProjectSession` directly when you need them.
 */
export function useProjectSessionRow(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: { enabled?: boolean },
): ProjectSession | undefined {
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId) && Boolean(sessionId) && (options?.enabled ?? true);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!projectId) return () => {};
      const prefix = JSON.stringify([...qk.project.sessionsScope(projectId), 'list']).slice(0, -1);
      return queryClient.getQueryCache().subscribe((event) => {
        if (JSON.stringify(event.query.queryKey).startsWith(prefix)) onChange();
      });
    },
    [projectId, queryClient],
  );
  const getSnapshot = useCallback(
    () =>
      enabled
        ? findCachedProjectSession(queryClient, projectId as string, sessionId as string)
        : undefined,
    [enabled, projectId, queryClient, sessionId],
  );
  const listed = useSyncExternalStore(subscribe, getSnapshot, () => undefined);

  const detail = useProjectSession(projectId, sessionId, { enabled: enabled && !listed });
  return enabled ? (listed ?? detail.data) : undefined;
}
