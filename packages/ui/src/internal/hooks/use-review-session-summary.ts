'use client';

import type { SessionsNeedingInputResponse } from '@kortix/sdk';
import { useReviewSummary, useSessionsNeedingInput } from '@kortix/sdk/react';
import { useMemo } from 'react';

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
 * Per-session review state for the always-mounted surfaces (sidebar, footer,
 * project settings, Sessions page). Reads the server's needs-you counts
 * (`GET /review/summary`, polled every 60 s), never the inbox list: the counts
 * cost the same with 5 or 5,000 finished items (KRTX-2316). Pass
 * `{ enabled: false }` to keep the poll dark (e.g. no project yet).
 */
export function useReviewSessionSummary(
  projectId: string,
  options?: { enabled?: boolean },
): ReviewSessionSummary {
  const { data } = useReviewSummary(projectId, {
    enabled: options?.enabled,
    refetchInterval: 60_000,
  });
  return useMemo(
    () =>
      data
        ? { totalNeedsYou: data.needs_you_total, needsYouBySession: data.needs_you_by_session }
        : EMPTY_SUMMARY,
    [data],
  );
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
