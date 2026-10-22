'use client';

import type { FileNode } from '../../../internal/files/types';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type FileListPage, listFiles } from '../api/runtime-files';
import { useProjectContext } from '../context';
import type { ExplorerQueryResult } from '../explorer-source';

export const fileListKeys = {
  all: ['project-files', 'list'] as const,
  dir: (projectId: string, ref: string, dirPath: string) =>
    ['project-files', 'list', projectId, ref, dirPath] as const,
};

/**
 * Fetch the directory listing for a path on the active project.
 *
 * Uses GET /v1/projects/:projectId/files?depth=1: one folder level, in pages
 * of `FILE_LIST_PAGE_SIZE` (KRTX-1723). `data` holds every page loaded so far;
 * `fetchNextPage` loads the next one while `hasNextPage`.
 */
export function useFileList(
  dirPath: string,
  options?: { enabled?: boolean },
): ExplorerQueryResult<FileNode[]> {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  const query = useInfiniteQuery({
    queryKey: fileListKeys.dir(projectId, ref, dirPath),
    queryFn: ({ pageParam }) => listFiles(projectId, ref, dirPath, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!projectId && !!ref && !!dirPath && options?.enabled !== false,
    staleTime: 5_000,
    gcTime: 2 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error: Error) => {
      // `error` is whatever the queryFn rejected with — React Query does not
      // guarantee it's an `Error` with a string `message`, so guard before
      // calling `.includes` (a non-string `message` previously crashed here
      // with `TypeError: t.message.includes is not a function`).
      const msg = typeof error?.message === 'string' ? error.message : '';
      if (msg.includes('404') || msg.includes('403')) return false;
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 5000),
  });

  const data = useMemo(() => query.data?.pages.flatMap((page) => page.nodes), [query.data]);

  return fileListResult(query, data);
}

/** The infinite query fields `fileListResult` reads. */
interface FileListQuery {
  data?: { pages: FileListPage[] };
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
}

/**
 * The explorer's view of the folder query. A failed "Load more" sets the
 * query's `error`; it is reported as `nextPageError` instead, so the pages
 * already on screen stay and the footer offers the retry.
 */
export function fileListResult(query: FileListQuery, data: FileNode[] | undefined): ExplorerQueryResult<FileNode[]> {
  const last = query.data?.pages.at(-1);
  return {
    data,
    isLoading: query.isLoading,
    // "Load more" has its own busy state; the toolbar's refresh spinner is for refetches.
    isFetching: query.isFetching && !query.isFetchingNextPage,
    error: query.isFetchNextPageError ? null : query.error,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    nextPageError: query.isFetchNextPageError ? query.error : null,
    truncated: !!last?.truncated && !last.nextCursor,
  };
}

export function useInvalidateFileList() {
  const queryClient = useQueryClient();
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  return (dirPath?: string) => {
    if (dirPath) {
      queryClient.invalidateQueries({
        queryKey: fileListKeys.dir(projectId, ref, dirPath),
      });
    } else {
      queryClient.invalidateQueries({
        queryKey: fileListKeys.all,
      });
    }
  };
}
