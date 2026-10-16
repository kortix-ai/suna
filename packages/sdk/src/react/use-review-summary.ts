'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import {
  getReviewSummary,
  listReviewItems,
  type ApiReviewItem,
  type ReviewItemsPage,
  type ReviewItemsQuery,
} from '../core/rest/projects-client';
import { qk } from './query-keys';

/**
 * The needs-you counts of the project's review inbox (`getReviewSummary`), for
 * a surface that is always on screen: a badge, a per-session indicator. It
 * never reads the list, so its cost does not grow with the inbox history
 * (KRTX-2316). Polls every 60 s by default; a verdict invalidates
 * `qk.project.reviewSummary(projectId)`.
 */
export function useReviewSummary(
  projectId: string,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  const enabled = Boolean(projectId) && options?.enabled !== false;
  return useQuery({
    queryKey: qk.project.reviewSummary(projectId),
    queryFn: () => getReviewSummary(projectId),
    enabled,
    staleTime: 5_000,
    refetchInterval: enabled ? (options?.refetchInterval ?? 60_000) : false,
    refetchOnWindowFocus: false,
  });
}

/** The cursor of the page after `page`, or undefined on the last page. */
export function nextReviewItemsCursor(page: ReviewItemsPage): string | undefined {
  return page.next_cursor ?? undefined;
}

/** Every item of the pages loaded so far, in inbox order. */
export function reviewItemsOf(
  data: { pages: ReadonlyArray<Pick<ReviewItemsPage, 'review_items'>> } | undefined,
): ApiReviewItem[] {
  return data?.pages.flatMap((page) => page.review_items) ?? [];
}

/**
 * The review inbox one page at a time (`listReviewItems`): `fetchNextPage`
 * loads the next one while `hasNextPage` is true. Read the items with
 * `reviewItemsOf(query.data)`. A poll (`refetchInterval`) refetches every
 * loaded page.
 */
export function useReviewItemPages(
  projectId: string,
  query: ReviewItemsQuery = {},
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useInfiniteQuery({
    queryKey: qk.project.reviewItemPages(projectId, query),
    queryFn: ({ pageParam }) => listReviewItems(projectId, { ...query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextReviewItemsCursor,
    enabled: Boolean(projectId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}
