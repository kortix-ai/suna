/**
 * use-review — the Review page's queries and its one mutation.
 *
 * The list is fetched whole, as on web: the three segments and their counts are
 * derived on the client (`mapApiReviewItem`, `reviewSegmentForStatus`), so a
 * verdict moves an item between segments without a second request. It polls
 * every 8 s while the page is mounted.
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
  type ReviewItemStatus,
  type ReviewVerdict,
} from '@kortix/sdk';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { closeChangeRequest, mergeChangeRequest } from '@/lib/projects/projects-client';

import { applyReviewStatuses, verdictResultStatus } from './review-optimistic';
import type { ReviewVerdictCall } from './review-verdict';

export const reviewKeys = {
  list: (projectId: string | null | undefined) => ['review-items', projectId] as const,
  verdict: (projectId: string | null | undefined) => ['review-verdict', projectId] as const,
};

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
  /** Off for a consumer that only needs the count (the project sheet's badge). */
  poll?: boolean;
}

export function useReviewItems(projectId: string | null, options: UseReviewItemsOptions = {}) {
  const { sessionLabels, poll = true } = options;
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
    (data: Awaited<ReturnType<typeof listReviewItems>>): ReviewItem[] =>
      applyReviewStatuses(
        data.review_items.map((row) => mapApiReviewItem(row, { sessionLabels })),
        overrides,
      ),
    [sessionLabels, overrides],
  );
  return useQuery({
    queryKey: reviewKeys.list(projectId),
    queryFn: () => listReviewItems(projectId!),
    enabled: !!projectId,
    staleTime: 5_000,
    refetchInterval: poll ? REVIEW_POLL_MS : false,
    select,
  });
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

type ApiReviewRow = Awaited<ReturnType<typeof listReviewItems>>['review_items'][number];

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
      queryClient.setQueryData<{ review_items: ApiReviewRow[] }>(reviewKeys.list(projectId), (old) =>
        old
          ? {
              ...old,
              review_items: old.review_items.map((row) =>
                row.review_item_id === itemId ? { ...row, status } : row,
              ),
            }
          : old,
      );
    },
    onError: (error) => onError?.(error),
    onSettled: (_data, _error, { plan }) => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.list(projectId) });
      if (plan.call === 'merge' || plan.call === 'close' || plan.call === 'request_changes') {
        // Same keys the Changes page invalidates after a merge or a close.
        queryClient.invalidateQueries({ queryKey: ['change-requests', projectId] });
        queryClient.invalidateQueries({ queryKey: ['change-request', projectId, plan.changeRequestId] });
      }
    },
  });
}
