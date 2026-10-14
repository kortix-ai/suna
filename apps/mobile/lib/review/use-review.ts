/**
 * use-review — the Review page's queries and its one mutation.
 *
 * The list is bounded (KRTX-2316): each read names what it needs (a segment,
 * a session's changes, the pending approvals) and the server returns it a page
 * of 50 at a time. The Review page reads one segment and offers its next page.
 * The project root reads only the needs-you counts (`useReviewNeedsYou`).
 *
 * `useReviewVerdict` runs the call `planReviewVerdict` chose. A Change Request
 * or a connector call never reaches `/act`.
 *
 * Optimistic (Jay, 2026-09-27): a merge takes seconds on the server, so a
 * verdict moves its item at the tap. Every `useReviewItems` reads the pending
 * verdicts (`useMutationState`) and shows each item in the status its verdict
 * lands it in (`review-optimistic.ts`). A success writes that status into the
 * cache before the refetch, so the item never flips back; a failure drops the
 * override and the item returns.
 */
import {
  actReviewItem,
  listReviewItems,
  mapApiReviewItem,
  requestChangesOnChangeRequest,
  resolveApproval,
  type ReviewItem,
  type ReviewItemKind,
  type ReviewItemsPage,
  type ReviewItemsQuery,
  type ReviewItemStatus,
  type ReviewVerdict,
} from '@kortix/sdk';
import { nextReviewItemsCursor, qk, useReviewSummary } from '@kortix/sdk/react';
import {
  type InfiniteData,
  type QueryClient,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { closeChangeRequest, mergeChangeRequest } from '@/lib/projects/projects-client';

import { applyReviewStatuses, verdictResultStatus } from './review-optimistic';
import type { ReviewVerdictCall } from './review-verdict';

export const reviewKeys = {
  /** Prefix of every review read of the project: invalidate and cancel by it. */
  list: (projectId: string | null | undefined) => ['review-items', projectId] as const,
  /** One filtered page set (`useReviewItems`). */
  pages: (projectId: string | null | undefined, query: ReviewItemsQuery) =>
    [
      ...reviewKeys.list(projectId),
      'pages',
      query.segment ?? 'all',
      query.kind ?? 'all',
      query.sessionId ?? 'all',
      query.limit ?? 'default',
    ] as const,
  /** The needs-you items behind one summary (`useReviewNeedsYou`). */
  needsYou: (projectId: string | null | undefined, summaryKey: string) =>
    [...reviewKeys.list(projectId), 'needs-you', summaryKey] as const,
  verdict: (projectId: string | null | undefined) => ['review-verdict', projectId] as const,
};

/**
 * Refetch the review reads after a decision, the needs-you counts with them,
 * and GET needs-input: the drawer and the Sessions page count a pending
 * connector call from both (`needsYouBySession`, KRTX-1739).
 */
export function invalidateReviewItems(queryClient: QueryClient, projectId: string): void {
  queryClient.invalidateQueries({ queryKey: reviewKeys.list(projectId) });
  queryClient.invalidateQueries({ queryKey: qk.project.reviewSummary(projectId) });
  queryClient.invalidateQueries({ queryKey: qk.project.needsInput(projectId) });
}

/** Set one item's status in every cached review read: a page set or a single page. */
export function withReviewItemStatus(
  data: unknown,
  itemId: string,
  status: ReviewItemStatus,
): unknown {
  const setIn = (page: ReviewItemsPage): ReviewItemsPage => ({
    ...page,
    review_items: page.review_items.map((row) =>
      row.review_item_id === itemId ? { ...row, status } : row,
    ),
  });
  if (!data || typeof data !== 'object') return data;
  if ('pages' in data) {
    const pages = data as InfiniteData<ReviewItemsPage>;
    return { ...pages, pages: pages.pages.map(setIn) };
  }
  if ('review_items' in data) return setIn(data as ReviewItemsPage);
  return data;
}

/** One verdict on one review item: the call to run, and the item it moves. */
export interface ReviewVerdictInput {
  itemId: string;
  verdict: ReviewVerdict;
  plan: ReviewVerdictCall;
  /** Names the item in the success toast (`reviewVerdictToast`). */
  kind: ReviewItemKind;
  /** A change request's number, for the same toast. */
  number?: number;
}

const REVIEW_POLL_MS = 8_000;

interface UseReviewItemsOptions {
  /** Session id → title. Names the originating session of a connector approval. */
  sessionLabels?: Record<string, string>;
  /** Off for a consumer that reads a cache another one polls. */
  poll?: boolean;
  /** What to read: a segment, one session's items, a kind. Each is its own page set. */
  query?: ReviewItemsQuery;
  enabled?: boolean;
}

/**
 * One filtered read of the review inbox, a page at a time: `data` is every
 * item of the loaded pages, mapped, with pending verdicts applied;
 * `fetchNextPage` loads the next page while `hasNextPage` is true.
 */
export function useReviewItems(projectId: string | null, options: UseReviewItemsOptions = {}) {
  const { sessionLabels, poll = true, query = {}, enabled = true } = options;
  const pending = useMutationState({
    filters: { mutationKey: reviewKeys.verdict(projectId), status: 'pending' },
    select: (mutation) => mutation.state.variables as ReviewVerdictInput | undefined,
  });
  const overrides = useMemo(() => {
    const byId: Record<string, ReviewItemStatus> = {};
    for (const input of pending) {
      if (input) byId[input.itemId] = verdictResultStatus(input.verdict);
    }
    return byId;
  }, [pending]);
  // The overrides apply inside `select`, and the query object is returned as
  // is. Spreading it (`{ ...query, data }`) reads every field, which turns off
  // TanStack's tracked-field renders: each consumer — `ProjectScreen`, the
  // project's root — then re-rendered on every fetch start and end, and the
  // app lagged on each 8 s poll and after a merge (Jay, 2026-09-27). A stable
  // `select` also stops the rows being re-mapped on every render.
  const select = useCallback(
    (data: InfiniteData<ReviewItemsPage, string | undefined>): ReviewItem[] =>
      applyReviewStatuses(
        data.pages.flatMap((page) =>
          page.review_items.map((row) => mapApiReviewItem(row, { sessionLabels })),
        ),
        overrides,
      ),
    [sessionLabels, overrides],
  );
  return useInfiniteQuery({
    queryKey: reviewKeys.pages(projectId, query),
    queryFn: ({ pageParam }) => listReviewItems(projectId!, { ...query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextReviewItemsCursor,
    enabled: !!projectId && enabled,
    staleTime: 5_000,
    refetchInterval: poll ? REVIEW_POLL_MS : false,
    select,
  });
}

/** At most this many needs-you items back the drawer's reasons (the server's ceiling). */
const NEEDS_YOU_ITEMS_LIMIT = 200;

/**
 * What waits on the user, for the project root and the Sessions page: the
 * needs-you counts (`GET /review/summary`, polled while `poll`), and the
 * needs-you items behind them, read again only when the counts change and
 * never while nothing waits. The drawer's reason line ("Approve: …") and its
 * order need the items; the badge needs only `total` (KRTX-2316).
 */
export function useReviewNeedsYou(projectId: string | null, { poll }: { poll: boolean }) {
  const summary = useReviewSummary(projectId ?? '', {
    refetchInterval: poll ? REVIEW_POLL_MS : false,
  });
  const total = summary.data?.needs_you_total ?? 0;
  const summaryKey = summary.data ? JSON.stringify(summary.data) : '';
  const items = useQuery({
    queryKey: reviewKeys.needsYou(projectId, summaryKey),
    queryFn: () =>
      listReviewItems(projectId!, { segment: 'needs_you', limit: NEEDS_YOU_ITEMS_LIMIT }),
    enabled: !!projectId && total > 0,
    staleTime: Infinity,
    // The previous reasons stay on screen while the next read is in flight.
    placeholderData: keepPreviousData,
    select: mapReviewPage,
  });
  return { total, items: total > 0 ? (items.data ?? NO_ITEMS) : NO_ITEMS };
}

/** One empty list, so a memo keyed by `items` holds while nothing waits. */
const NO_ITEMS: ReviewItem[] = [];

/** Module-level, so `select` keeps one reference and maps once per response. */
function mapReviewPage(data: ReviewItemsPage): ReviewItem[] {
  return data.review_items.map((row) => mapApiReviewItem(row));
}

function runReviewVerdictCall(projectId: string, plan: ReviewVerdictCall): Promise<unknown> {
  switch (plan.call) {
    case 'act':
      return actReviewItem(projectId, plan.reviewItemId, {
        verdict: plan.verdict,
        feedback: plan.feedback,
      });
    case 'merge':
      return mergeChangeRequest(projectId, plan.changeRequestId);
    case 'close':
      return closeChangeRequest(projectId, plan.changeRequestId);
    case 'request_changes':
      return requestChangesOnChangeRequest(projectId, plan.changeRequestId, plan.feedback);
    case 'resolve_approval':
      return resolveApproval(projectId, plan.executionId, plan.decision);
  }
}

/**
 * `onSuccess` and `onError` run for every verdict. A per-call
 * `mutate(…, { onError })` fires only for the latest call, so a second verdict
 * sent while the first merge still runs would swallow the first one's result.
 */
export function useReviewVerdict(
  projectId: string,
  options: { onSuccess?: (input: ReviewVerdictInput) => void; onError?: (error: unknown) => void } = {},
) {
  const queryClient = useQueryClient();
  const { onSuccess, onError } = options;
  return useMutation({
    mutationKey: reviewKeys.verdict(projectId),
    mutationFn: ({ plan }: ReviewVerdictInput) => runReviewVerdictCall(projectId, plan),
    // A poll in flight read the list before the verdict: drop its answer.
    onMutate: () => queryClient.cancelQueries({ queryKey: reviewKeys.list(projectId) }),
    onSuccess: async (_data, input) => {
      const { itemId, verdict } = input;
      onSuccess?.(input);
      // Keep the item where the tap put it until the refetch lands.
      await queryClient.cancelQueries({ queryKey: reviewKeys.list(projectId) });
      const status = verdictResultStatus(verdict);
      queryClient.setQueriesData({ queryKey: reviewKeys.list(projectId) }, (old: unknown) =>
        withReviewItemStatus(old, itemId, status),
      );
    },
    onError: (error) => onError?.(error),
    onSettled: (_data, _error, { plan }) => {
      invalidateReviewItems(queryClient, projectId);
      if (plan.call === 'merge' || plan.call === 'close' || plan.call === 'request_changes') {
        // Same keys the Changes page invalidates after a merge or a close.
        queryClient.invalidateQueries({ queryKey: ['change-requests', projectId] });
        queryClient.invalidateQueries({ queryKey: ['change-request', projectId, plan.changeRequestId] });
      }
    },
  });
}
