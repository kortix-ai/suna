'use client';

import { useWorkspaceContext } from '@/features/workspace-files/context';
import {
  type ApiReviewItem,
  type ReviewVerdict,
  actReviewItem,
  bulkActReviewItems,
  listReviewItems,
  resolveApproval,
  submitReviewItem,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const reviewKeys = {
  all: ['review-center'] as const,
  list: (workspaceId: string) => ['review-center', workspaceId, 'list'] as const,
};

/** All review items for the active project (the inbox segments + counts are
 *  derived client-side, so we fetch the whole list and poll). */
export function useReviewItems(options?: { enabled?: boolean; refetchInterval?: number }) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  return useQuery<{ review_items: ApiReviewItem[] }>({
    queryKey: reviewKeys.list(workspaceId),
    queryFn: () => listReviewItems(workspaceId),
    enabled: Boolean(workspaceId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: options?.refetchInterval ?? 8_000,
  });
}

function useInvalidate(workspaceId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['review-center', workspaceId] });
}

export function useActReviewItem() {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidate(workspaceId);
  return useMutation<
    ApiReviewItem,
    Error,
    { id: string; verdict: ReviewVerdict; feedback?: string }
  >({
    mutationFn: ({ id, verdict, feedback }) => actReviewItem(workspaceId, id, { verdict, feedback }),
    onSuccess: invalidate,
  });
}

export function useBulkActReviewItems() {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidate(workspaceId);
  return useMutation<
    { updated: number; review_items: ApiReviewItem[] },
    Error,
    { ids: string[]; verdict: ReviewVerdict }
  >({
    mutationFn: ({ ids, verdict }) => bulkActReviewItems(workspaceId, { ids, verdict }),
    onSuccess: invalidate,
  });
}

export function useSubmitReviewItem() {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidate(workspaceId);
  return useMutation<ApiReviewItem, Error, Parameters<typeof submitReviewItem>[1]>({
    mutationFn: (input) => submitReviewItem(workspaceId, input),
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
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidate(workspaceId);
  return useMutation<
    { ok: boolean },
    Error,
    { executionId: string; decision: 'approve' | 'deny' }
  >({
    mutationFn: ({ executionId, decision }) =>
      resolveApproval(workspaceId, executionId, decision),
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
