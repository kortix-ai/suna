'use client';

import { listReviewItems, type ApiReviewItem, type SessionsNeedingInputResponse } from '@kortix/sdk';
import { useSessionsNeedingInput } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

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
 * client-side. Pass `{ enabled: false }` to keep the poll dark (e.g. no project
 * yet).
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
    // Mutations invalidate this key. The background poll catches external work.
    refetchInterval: enabled ? 60_000 : false,
    refetchOnWindowFocus: false,
    // `select` transforms per-observer without touching the shared cache entry, so
    // the Review Center view still reads the raw `{ review_items }` off the same key.
    select: (result) => summarizeReviewSessions(result.review_items),
  });
  return data ?? EMPTY_SUMMARY;
}

/**
 * Fold GET needs-input (open agent questions and pending connector approvals,
 * per session) into the review counts by session (KRTX-1739). A session takes
 * the larger of its two counts: a pending connector approval is in both lists,
 * and a sum would count it twice. The summary also keys each session by its
 * runtime id; the lists look sessions up by `session_id`, so that key is inert.
 * Pure + exported for unit tests.
 */
export function withNeedsInput(
  bySession: Record<string, number>,
  needsInput: SessionsNeedingInputResponse | undefined,
): Record<string, number> {
  if (!needsInput?.total) return bySession;
  const merged = { ...bySession };
  for (const [sessionId, count] of Object.entries(needsInput.sessions)) {
    merged[sessionId] = Math.max(merged[sessionId] ?? 0, count);
  }
  return merged;
}

/**
 * What waits on the viewer, by session, for the session lists: the review
 * inbox and every open agent question or connector approval. A positive count
 * makes the row `needs-you` (`sessionDisplayStatus`). The sidebar and the
 * Sessions page read this one shape. The needs-input read is the project
 * shell's 30 s poll (`ProjectShell`); this only reads its cache.
 */
export function useSessionNeedsYouCounts(projectId: string): Record<string, number> {
  const { needsYouBySession } = useReviewSessionSummary(projectId);
  const { data: needsInput } = useSessionsNeedingInput(projectId, { enabled: false });
  return useMemo(() => withNeedsInput(needsYouBySession, needsInput), [needsYouBySession, needsInput]);
}
