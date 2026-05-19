'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createChangeRequest,
  fetchChangeRequest,
  fetchChangeRequestDiff,
  fetchChangeRequestMergePreview,
  fetchChangeRequests,
  fetchVersionDiff,
  performClose,
  performMerge,
  performReopen,
  type ChangeRequest,
  type ChangeRequestDetailResponse,
  type ChangeRequestDiffResponse,
  type ChangeRequestMergePreview,
  type ChangeRequestMergeResponse,
  type ChangeRequestStatus,
  type VersionDiffPreview,
} from '../api/change-requests';
import { useProjectContext } from '../context';

export const changeRequestKeys = {
  all: ['project-files', 'change-requests'] as const,
  list: (projectId: string, status: ChangeRequestStatus | 'all') =>
    ['project-files', 'change-requests', projectId, 'list', status] as const,
  detail: (projectId: string, crId: string) =>
    ['project-files', 'change-requests', projectId, crId] as const,
  diff: (projectId: string, crId: string) =>
    ['project-files', 'change-requests', projectId, crId, 'diff'] as const,
  preview: (projectId: string, crId: string) =>
    ['project-files', 'change-requests', projectId, crId, 'merge-preview'] as const,
};

export function useChangeRequests(
  status: ChangeRequestStatus | 'all' = 'all',
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useQuery<{ change_requests: ChangeRequest[] }>({
    queryKey: changeRequestKeys.list(projectId, status),
    queryFn: () => fetchChangeRequests(projectId, status),
    enabled: Boolean(projectId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: options?.refetchInterval,
  });
}

export function useChangeRequest(crId: string | null, options?: { enabled?: boolean }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useQuery<ChangeRequestDetailResponse>({
    queryKey: crId
      ? changeRequestKeys.detail(projectId, crId)
      : ['project-files', 'change-requests', 'idle'],
    queryFn: () => fetchChangeRequest(projectId, crId as string),
    enabled: Boolean(projectId && crId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: 8_000,
  });
}

export function useChangeRequestDiff(crId: string | null) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useQuery<ChangeRequestDiffResponse>({
    queryKey: crId
      ? changeRequestKeys.diff(projectId, crId)
      : ['project-files', 'change-requests', 'diff', 'idle'],
    queryFn: () => fetchChangeRequestDiff(projectId, crId as string),
    enabled: Boolean(projectId && crId),
    staleTime: 10_000,
  });
}

/**
 * Live diff preview between two refs — used by the Open-CR dialog so the
 * user sees "X files changed" (or "no changes") before submitting. Cheap
 * server-side query that does NOT create a CR.
 */
export function useVersionDiff(
  input: { from: string; into: string } | null,
  options?: { enabled?: boolean },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const canRun = Boolean(projectId && input?.from && input?.into);
  return useQuery<VersionDiffPreview>({
    queryKey: canRun
      ? ['project-files', 'version-diff', projectId, input!.from, input!.into]
      : ['project-files', 'version-diff', 'idle'],
    queryFn: () => fetchVersionDiff(projectId, input!),
    enabled: canRun && options?.enabled !== false,
    staleTime: 10_000,
  });
}

export function useChangeRequestMergePreview(crId: string | null, enabled = true) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useQuery<ChangeRequestMergePreview>({
    queryKey: crId
      ? changeRequestKeys.preview(projectId, crId)
      : ['project-files', 'change-requests', 'preview', 'idle'],
    queryFn: () => fetchChangeRequestMergePreview(projectId, crId as string),
    enabled: Boolean(projectId && crId) && enabled,
    staleTime: 10_000,
  });
}

/**
 * Invalidates every CR query for the active project — used after open / merge
 * / close / reopen so all panels and detail views re-fetch.
 */
function useInvalidateAll() {
  const qc = useQueryClient();
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return () => {
    qc.invalidateQueries({ queryKey: ['project-files', 'change-requests', projectId] });
    // Branches list shows ahead/behind that may shift after a merge.
    qc.invalidateQueries({ queryKey: ['project-files', 'branches', projectId] });
    // The merge commit lands on the default branch — commit list goes stale.
    qc.invalidateQueries({ queryKey: ['project-files', 'commits', projectId] });
  };
}

export function useOpenChangeRequest() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<
    ChangeRequest,
    Error,
    { title: string; description?: string; head_ref: string; base_ref?: string; session_id?: string }
  >({
    mutationFn: (input) => createChangeRequest(projectId, input),
    onSuccess: invalidate,
  });
}

export function useMergeChangeRequest() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<ChangeRequestMergeResponse, Error, string>({
    mutationFn: (crId) => performMerge(projectId, crId),
    onSuccess: invalidate,
  });
}

export function useCloseChangeRequest() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<ChangeRequest, Error, string>({
    mutationFn: (crId) => performClose(projectId, crId),
    onSuccess: invalidate,
  });
}

export function useReopenChangeRequest() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<ChangeRequest, Error, string>({
    mutationFn: (crId) => performReopen(projectId, crId),
    onSuccess: invalidate,
  });
}
