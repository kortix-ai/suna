'use client';

import { useProjectContext } from '@/features/project-files/context';
import {
  type ApiReviewItem,
  type ReviewVerdict,
  actReviewItem,
  bulkActReviewItems,
  listReviewItems,
  resolveApproval,
  submitReviewItem,
} from '@kortix/sdk/projects-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const reviewKeys = {
  all: ['review-center'] as const,
  list: (projectId: string) => ['review-center', projectId, 'list'] as const,
};

/** All review items for the active project (the inbox segments + counts are
 *  derived client-side, so we fetch the whole list and poll). */
export function useReviewItems(options?: { enabled?: boolean; refetchInterval?: number }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useQuery<{ review_items: ApiReviewItem[] }>({
    queryKey: reviewKeys.list(projectId),
    queryFn: () => listReviewItems(projectId),
    enabled: Boolean(projectId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: options?.refetchInterval ?? 8_000,
  });
}

function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['review-center', projectId] });
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

export function useSubmitReviewItem() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidate(projectId);
  return useMutation<ApiReviewItem, Error, Parameters<typeof submitReviewItem>[1]>({
    mutationFn: (input) => submitReviewItem(projectId, input),
    onSuccess: invalidate,
  });
}

/**
 * Resolve an executor approval (`exec:` adapted review item) directly from the
 * inbox — the SAME call + payload the in-session approval prompt uses
 * (`resolveApproval`, via `SessionApprovalPrompt` → `useResolveApproval` in
 * session-audit-shared.tsx). Scope is always `'once'` here: the inbox acts on
 * one specific pending call, not "for the rest of this session" — that
 * broader scope stays a session-view-only affordance since it needs the
 * session's other pending rows in view to make sense.
 */
export function useResolveReviewApproval() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidate(projectId);
  return useMutation<
    { ok: boolean; scope?: 'once' | 'session' | 'session_all' },
    Error,
    { executionId: string; decision: 'approve' | 'deny' }
  >({
    mutationFn: ({ executionId, decision }) =>
      resolveApproval(projectId, executionId, decision, 'once'),
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
