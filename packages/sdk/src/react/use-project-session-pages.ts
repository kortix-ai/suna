'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import {
  listProjectSessionsPage,
  type ProjectSession,
  type ProjectSessionPage,
} from '../core/rest/projects-client';

import {
  findCachedProjectSession,
  flattenProjectSessionPages,
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
   * Poll policy, decided from the sessions loaded so far. A poll refetches
   * every loaded page in order (TanStack infinite-query refetch), so the
   * cursor chain stays consistent.
   */
  refetchInterval?: (sessions: ProjectSession[]) => number | false;
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
 */
export function useProjectSessionPages(
  projectId: string | undefined,
  options?: UseProjectSessionPagesOptions,
) {
  const scope = options?.scope ?? 'visible';
  const pageSize = options?.pageSize ?? PROJECT_SESSION_PAGE_SIZE;
  const refetchInterval = options?.refetchInterval;

  return useInfiniteQuery({
    queryKey: qk.project.sessionPages(projectId ?? '', scope, pageSize),
    queryFn: ({ pageParam }): Promise<ProjectSessionPage> =>
      listProjectSessionsPage(projectId as string, {
        scope,
        limit: pageSize,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    select: flattenProjectSessionPages,
    enabled: Boolean(projectId) && (options?.enabled ?? true),
    refetchInterval: refetchInterval
      ? (query) =>
          refetchInterval(
            flattenProjectSessionPages(query.state.data as ProjectSessionPagesData | undefined),
          )
      : undefined,
    refetchOnWindowFocus: options?.refetchOnWindowFocus,
    ...contract('inventory'),
  });
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
