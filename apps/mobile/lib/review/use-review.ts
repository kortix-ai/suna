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
 */
import {
  actReviewItem,
  listReviewItems,
  mapApiReviewItem,
  requestChangesOnChangeRequest,
  resolveApproval,
  type ReviewItem,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { closeChangeRequest, mergeChangeRequest } from '@/lib/projects/projects-client';

import type { ReviewVerdictCall } from './review-verdict';

export const reviewKeys = {
  list: (projectId: string | null | undefined) => ['review-items', projectId] as const,
};

const REVIEW_POLL_MS = 8_000;

interface UseReviewItemsOptions {
  /** Session id → title. Names the originating session of a connector approval. */
  sessionLabels?: Record<string, string>;
  /** Off for a consumer that only needs the count (the project sheet's badge). */
  poll?: boolean;
}

export function useReviewItems(projectId: string | null, options: UseReviewItemsOptions = {}) {
  const { sessionLabels, poll = true } = options;
  return useQuery({
    queryKey: reviewKeys.list(projectId),
    queryFn: () => listReviewItems(projectId!),
    enabled: !!projectId,
    staleTime: 5_000,
    refetchInterval: poll ? REVIEW_POLL_MS : false,
    select: (data): ReviewItem[] =>
      data.review_items.map((row) => mapApiReviewItem(row, { sessionLabels })),
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

export function useReviewVerdict(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plan: ReviewVerdictCall) => runReviewVerdictCall(projectId, plan),
    onSettled: (_data, _error, plan) => {
      queryClient.invalidateQueries({ queryKey: reviewKeys.list(projectId) });
      if (plan.call === 'merge' || plan.call === 'close' || plan.call === 'request_changes') {
        // Same keys the Changes page invalidates after a merge or a close.
        queryClient.invalidateQueries({ queryKey: ['change-requests', projectId] });
        queryClient.invalidateQueries({ queryKey: ['change-request', projectId, plan.changeRequestId] });
      }
    },
  });
}
