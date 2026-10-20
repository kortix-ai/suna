'use client';

import type { SessionsNeedingInputResponse } from '@kortix/sdk';
import { useReviewSummary, useSessionsNeedingInput } from '@kortix/sdk/react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

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

// Mounted readers of GET needs-input per project, in mount order. The first one polls.
const needsInputReaders = new Map<string, number[]>();
const readerListeners = new Set<() => void>();
let lastReaderToken = 0;
const notifyReaders = () => readerListeners.forEach((listener) => listener());
const subscribeReaders = (listener: () => void) => {
  readerListeners.add(listener);
  return () => void readerListeners.delete(listener);
};

/**
 * True for exactly one mounted caller per project: the oldest. When it unmounts,
 * the next one takes over. The sidebar and the Sessions page both mount
 * `useSessionNeedsYouCounts`, and one 30 s poll serves both (one read per 30 s).
 * Exported for unit tests.
 */
export function useIsNeedsInputPoller(projectId: string): boolean {
  const [token] = useState(() => ++lastReaderToken);
  useEffect(() => {
    if (!projectId) return;
    needsInputReaders.set(projectId, [...(needsInputReaders.get(projectId) ?? []), token]);
    notifyReaders();
    return () => {
      const rest = (needsInputReaders.get(projectId) ?? []).filter((t) => t !== token);
      if (rest.length) needsInputReaders.set(projectId, rest);
      else needsInputReaders.delete(projectId);
      notifyReaders();
    };
  }, [projectId, token]);
  return useSyncExternalStore(
    subscribeReaders,
    () => needsInputReaders.get(projectId)?.[0] === token,
    () => false,
  );
}

/**
 * What waits on the viewer, by session, for the session lists: the review
 * inbox and every open agent question or connector approval. A positive count
 * makes the row `needs-you` (`sessionDisplayStatus`). The sidebar and the
 * Sessions page read this one shape. The hook polls GET needs-input every 30 s
 * by itself, once per project however many lists mount, so a host that mounts
 * `ProjectSessionList` alone still sees open questions.
 */
export function useSessionNeedsYouCounts(projectId: string): Record<string, number> {
  const { needsYouBySession } = useReviewSessionSummary(projectId);
  const poller = useIsNeedsInputPoller(projectId);
  const { data: needsInput } = useSessionsNeedingInput(projectId, { enabled: poller });
  return useMemo(() => withNeedsInput(needsYouBySession, needsInput), [needsYouBySession, needsInput]);
}
