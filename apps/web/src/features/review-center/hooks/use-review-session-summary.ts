'use client';

import { listReviewItems, type ApiReviewItem } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';

import { reviewKeys } from './use-review-items';

/**
 * The one derived view the sidebar needs from the review inbox: how many items
 * are awaiting the human (`needs_you`) in total, and how that breaks down per
 * originating session. Both the aggregate "Review" badge and the per-session row
 * indicators read from this SAME shape (and the same query cache), so the number
 * on the pill always equals the sum of the dots — one coherent system.
 */
export interface ReviewSessionSummary {
  /** Total items awaiting the human across the project (matches the rail badge). */
  totalNeedsYou: number;
  /**
   * `needs_you` count keyed by `origin_session_id`. Sessions with nothing pending
   * are absent (0), so a row lights up iff its id is present with a positive count.
   */
  needsYouBySession: Record<string, number>;
}

const EMPTY_SUMMARY: ReviewSessionSummary = { totalNeedsYou: 0, needsYouBySession: {} };

/**
 * Fold the flat inbox list into the `needs_you`-by-session summary. Items with no
 * originating session still count toward the total (they belong in the inbox) but
 * can't be attributed to a row. Pure + exported for unit tests.
 */
export function summarizeReviewSessions(items: readonly ApiReviewItem[]): ReviewSessionSummary {
  const needsYouBySession: Record<string, number> = {};
  let totalNeedsYou = 0;
  for (const item of items) {
    if (item.status !== 'needs_you') continue;
    totalNeedsYou += 1;
    const sessionId = item.origin_session_id;
    if (sessionId) {
      needsYouBySession[sessionId] = (needsYouBySession[sessionId] ?? 0) + 1;
    }
  }
  return { totalNeedsYou, needsYouBySession };
}

/**
 * Per-session review state for the project sidebar. Reads the unified inbox via
 * the shared `['review-center', projectId, 'list']` query key (deduping with the
 * Review Center view and the Customize rail badge), and derives the summary
 * client-side. Gate the caller on the `review_center` flag — pass
 * `{ enabled: false }` to keep the poll (and the surface) dark when it's off.
 */
export function useReviewSessionSummary(
  projectId: string,
  options?: { enabled?: boolean },
): ReviewSessionSummary {
  const enabled = Boolean(projectId) && options?.enabled !== false;
  const { data } = useQuery<{ review_items: ApiReviewItem[] }, Error, ReviewSessionSummary>({
    queryKey: reviewKeys.list(projectId),
    queryFn: () => listReviewItems(projectId),
    enabled,
    staleTime: 5_000,
    // Slower than the open inbox's 8s poll — the sidebar only needs the count to
    // feel live, not instant. When disabled the query never runs, so no poll.
    refetchInterval: enabled ? 20_000 : false,
    refetchOnWindowFocus: false,
    // `select` transforms per-observer without touching the shared cache entry, so
    // the Review Center view still reads the raw `{ review_items }` off the same key.
    select: (result) => summarizeReviewSessions(result.review_items),
  });
  return data ?? EMPTY_SUMMARY;
}
