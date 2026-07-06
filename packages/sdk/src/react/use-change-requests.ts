'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closeChangeRequest,
  listChangeRequests,
  mergeChangeRequest,
  openChangeRequest,
  requestChangesOnChangeRequest,
  type ChangeRequest,
  type ChangeRequestStatus,
} from '../platform/projects-client';

/** Stable query-key factory — reuse to read/invalidate the same cache entry
 *  `useChangeRequests` populates. */
export const changeRequestsKey = (projectId: string | null | undefined) =>
  ['project-change-requests', projectId] as const;

/**
 * Change requests — the Kortix-native PR layer. List + open/merge/close/
 * request-changes, the CRUD surface a Review Center / workbench "Changes" tab
 * needs. Thin React Query binding over `projects-client/change-requests.ts`;
 * every mutation invalidates the list so status transitions (open → merged/
 * closed, or back to open on reopen) show up without a manual refetch.
 * Per-CR detail reads (diff, merge-preview) stay direct client calls — they're
 * one-shot views, not a list this hook owns.
 */
export function useChangeRequests(
  projectId: string | null | undefined,
  status?: ChangeRequestStatus | 'all',
) {
  const queryClient = useQueryClient();
  const queryKey = [...changeRequestsKey(projectId), status ?? 'open'] as const;

  const query = useQuery<{ change_requests: ChangeRequest[] }>({
    queryKey,
    queryFn: () => listChangeRequests(projectId as string, status),
    enabled: !!projectId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: changeRequestsKey(projectId) });

  const open = useMutation({
    mutationFn: (input: Parameters<typeof openChangeRequest>[1]) =>
      openChangeRequest(projectId as string, input),
    onSuccess: invalidate,
  });

  const merge = useMutation({
    mutationFn: (args: { crId: string; input?: Parameters<typeof mergeChangeRequest>[2] }) =>
      mergeChangeRequest(projectId as string, args.crId, args.input),
    onSuccess: invalidate,
  });

  const close = useMutation({
    mutationFn: (crId: string) => closeChangeRequest(projectId as string, crId),
    onSuccess: invalidate,
  });

  const requestChanges = useMutation({
    mutationFn: (args: { crId: string; feedback: string }) =>
      requestChangesOnChangeRequest(projectId as string, args.crId, args.feedback),
    onSuccess: invalidate,
  });

  return { ...query, open, merge, close, requestChanges };
}
