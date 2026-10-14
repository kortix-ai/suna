'use client';

import { useProjectContext } from '@/features/project-files/context';
import {
  type ApiReviewItem,
  type ReviewSegment,
  type ReviewVerdict,
  actReviewItem,
  bulkActReviewItems,
  resolveApproval,
} from '@kortix/sdk';
import { qk, useReviewItemPages } from '@kortix/sdk/react';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * One segment of the active project's inbox, a page at a time (KRTX-2316):
 * the server filters the segment and returns 50 items per page, so a project
 * with thousands of finished items costs the same as one with five. Kind,
 * session and search filter the loaded pages. Polls every 8 s.
 */
export function useReviewItems(
  segment: ReviewSegment,
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useReviewItemPages(
    projectId,
    { segment },
    { enabled: options?.enabled, refetchInterval: options?.refetchInterval ?? 8_000 },
  );
}

/**
 * Refetch the inbox after a verdict: every loaded page, the needs-you counts,
 * and GET needs-input with them, because the session lists count a pending
 * connector call from both (KRTX-1739).
 */
export async function invalidateReviewInbox(qc: QueryClient, projectId: string): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.project.reviewItemsScope(projectId) }),
    qc.invalidateQueries({ queryKey: qk.project.reviewSummary(projectId) }),
    qc.invalidateQueries({ queryKey: qk.project.needsInput(projectId) }),
  ]);
}

function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => invalidateReviewInbox(qc, projectId);
}

export function useActReviewItem() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidate(projectId);
  return useMutation<
    ApiReviewItem,
    Error,
    { id: string; verdict: ReviewVerdict; feedback?: string }
  >({
    mutationFn: ({ id, verdict, feedback }) => actReviewItem(projectId, id, { verdict, feedback }),
    onSuccess: invalidate,
  });
}

export function useBulkActReviewItems() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidate(projectId);
  return useMutation<
    { updated: number; review_items: ApiReviewItem[] },
    Error,
    { ids: string[]; verdict: ReviewVerdict }
  >({
    mutationFn: ({ ids, verdict }) => bulkActReviewItems(projectId, { ids, verdict }),
    onSuccess: invalidate,
  });
}

/**
 * Resolve a connector approval (`call:` adapted review item) directly from the
 * inbox — the SAME call + payload the in-session approval prompt uses
 * (`resolveApproval`, via `SessionApprovalPrompt` → `useResolveApproval` in
 * session-audit-shared.tsx). A decision always applies to the one call that
 * asked for it — the "for the rest of this session" scopes were removed
 * because they pre-authorised later calls with different arguments.
 */
export function useResolveReviewApproval() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidate(projectId);
  return useMutation<
    { ok: boolean },
    Error,
    { executionId: string; decision: 'approve' | 'deny'; note?: string }
  >({
    mutationFn: ({ executionId, decision, note }) =>
      resolveApproval(projectId, executionId, decision, { note }),
    onSuccess: invalidate,
    // Every call site (review-center-connected.tsx) passes its own call-time
    // `onError` to `resolve.mutate(vars, { onError })` and shows a specific
    // toast. Without this no-op, TanStack Query's `defaultMutationOptions()`
    // merge falls back to the QueryClient's global default mutation
    // `onError` (apps/web/src/app/react-query-provider.tsx), which ALSO
    // fires — producing a second, generic "Failed to perform action:
    // <message>" toast alongside the intended one. Same fix, same reasoning,
    // as `resolveApprovalMutationOptions` in session-audit-shared.tsx, which
    // this hook mirrors (same underlying `resolveApproval` action/endpoint —
    // a stale inbox row can 404 with "not found" if it was already resolved
    // elsewhere before the poll caught up).
    onError: () => {},
  });
}
