'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  commitSessionChangesRequest,
  createChangeRequest,
  fetchChangeRequest,
  fetchChangeRequestDiff,
  fetchChangeRequestMergePreview,
  fetchChangeRequests,
  fetchVersionDiff,
  performClose,
  performMerge,
  performReopen,
  performRequestChanges,
  type WorkspaceChangeRequest,
  type ChangeRequestDetailResponse,
  type ChangeRequestDiffResponse,
  type ChangeRequestMergePreview,
  type ChangeRequestMergeResponse,
  type ChangeRequestStatus,
  type CommitSessionResult,
  type VersionDiffPreview,
} from '../api/change-requests';
import { useWorkspaceContext } from '../context';
import { gitStatusKeys } from '@/features/files/hooks/use-git-status';
import { branchKeys } from './use-branches';
import { commitKeys } from './use-commits';
import { qk } from '@kortix/sdk/react';

export const changeRequestKeys = {
  all: ['workspace-files', 'change-requests'] as const,
  /** Project-scoped, status-agnostic prefix — every CR list/detail/diff/preview
   *  for one workspace, regardless of status. Used for "something about this
   *  workspace's CRs changed" invalidation; `all` above is unscoped (every
   *  workspace) and too broad for that. */
  workspace: (workspaceId: string) => ['workspace-files', 'change-requests', workspaceId] as const,
  list: (workspaceId: string, status: ChangeRequestStatus | 'all') =>
    ['workspace-files', 'change-requests', workspaceId, 'list', status] as const,
  detail: (workspaceId: string, crId: string) =>
    ['workspace-files', 'change-requests', workspaceId, crId] as const,
  diff: (workspaceId: string, crId: string) =>
    ['workspace-files', 'change-requests', workspaceId, crId, 'diff'] as const,
  preview: (workspaceId: string, crId: string) =>
    ['workspace-files', 'change-requests', workspaceId, crId, 'merge-preview'] as const,
};

/**
 * `useVersionDiff`'s key family — kept local (not exported elsewhere) since
 * this is its only reader/invalidator.
 */
const versionDiffKeys = {
  workspace: (workspaceId: string) => ['workspace-files', 'version-diff', workspaceId] as const,
  diff: (workspaceId: string, from: string, into: string) =>
    ['workspace-files', 'version-diff', workspaceId, from, into] as const,
  idle: ['workspace-files', 'version-diff', 'idle'] as const,
};

export function useChangeRequests(
  status: ChangeRequestStatus | 'all' = 'all',
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  return useQuery<{ change_requests: WorkspaceChangeRequest[] }>({
    queryKey: changeRequestKeys.list(workspaceId, status),
    queryFn: () => fetchChangeRequests(workspaceId, status),
    enabled: Boolean(workspaceId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: options?.refetchInterval,
  });
}

export function useChangeRequest(crId: string | null, options?: { enabled?: boolean }) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  return useQuery<ChangeRequestDetailResponse>({
    queryKey: crId
      ? changeRequestKeys.detail(workspaceId, crId)
      : ['workspace-files', 'change-requests', 'idle'],
    queryFn: () => fetchChangeRequest(workspaceId, crId as string),
    enabled: Boolean(workspaceId && crId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: 8_000,
  });
}

export function useChangeRequestDiff(crId: string | null) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  return useQuery<ChangeRequestDiffResponse>({
    queryKey: crId
      ? changeRequestKeys.diff(workspaceId, crId)
      : ['workspace-files', 'change-requests', 'diff', 'idle'],
    queryFn: () => fetchChangeRequestDiff(workspaceId, crId as string),
    enabled: Boolean(workspaceId && crId),
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
  options?: { enabled?: boolean; workspaceId?: string },
) {
  const ctx = useWorkspaceContext();
  const workspaceId = options?.workspaceId ?? ctx?.workspaceId ?? '';
  const canRun = Boolean(workspaceId && input?.from && input?.into);
  return useQuery<VersionDiffPreview>({
    queryKey: canRun
      ? versionDiffKeys.diff(workspaceId, input!.from, input!.into)
      : versionDiffKeys.idle,
    queryFn: () => fetchVersionDiff(workspaceId, input!),
    enabled: canRun && options?.enabled !== false,
    staleTime: 10_000,
  });
}

export function useChangeRequestMergePreview(crId: string | null, enabled = true) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  return useQuery<ChangeRequestMergePreview>({
    queryKey: crId
      ? changeRequestKeys.preview(workspaceId, crId)
      : ['workspace-files', 'change-requests', 'preview', 'idle'],
    queryFn: () => fetchChangeRequestMergePreview(workspaceId, crId as string),
    enabled: Boolean(workspaceId && crId) && enabled,
    staleTime: 10_000,
  });
}

/**
 * Invalidates every CR query for the active workspace — used after open / merge
 * / close / reopen so all panels and detail views re-fetch.
 */
function useInvalidateAll(workspaceIdArg?: string) {
  const qc = useQueryClient();
  const ctx = useWorkspaceContext();
  const workspaceId = workspaceIdArg ?? ctx?.workspaceId ?? '';
  return () => {
    qc.invalidateQueries({ queryKey: changeRequestKeys.workspace(workspaceId) });
    // Branches list shows ahead/behind that may shift after a merge.
    qc.invalidateQueries({ queryKey: branchKeys.list(workspaceId) });
    // The merge commit lands on the default branch — commit list goes stale.
    qc.invalidateQueries({ queryKey: commitKeys.workspace(workspaceId) });
    // Whether this version still differs from its base changes the moment a CR
    // merges — refresh the "Alternate version of main · N changes" banner
    // (git-status, which is otherwise sticky and never re-fetches on its own),
    // the live version-diff preview, and the cached session row (base_ref etc.).
    qc.invalidateQueries({ queryKey: gitStatusKeys.all });
    qc.invalidateQueries({ queryKey: versionDiffKeys.workspace(workspaceId) });
    // Every individual git-connected session under this workspace — a CR
    // landing on the base ref can change what `getWorkspaceSession` returns
    // (base_ref etc.) for any of them. sessionsScope is the shared prefix
    // that reaches the sessions list AND every qk.workspace.session(id, sid)
    // entry in one call; there is no "every session, not the list" prefix to
    // narrow to, so this deliberately also refreshes the sessions list.
    qc.invalidateQueries({ queryKey: qk.workspace.sessionsScope(workspaceId) });
    // Landing a CR on the base ref is the one thing that happens INSIDE the app
    // that can make an open session's compiled agent config stale. The
    // freshness query is deliberately not polled — this is what tells it to
    // look again, so the chip appears on merge rather than on next focus.
    qc.invalidateQueries({ queryKey: ['session-config', workspaceId] });
  };
}

/**
 * Commit + push the session sandbox's pending changes to its branch.
 *
 * NOTE (2026-05-29): currently UNUSED. Built for a one-click fully-UI "Open
 * change request" flow; the shipped flow instead asks the agent to commit +
 * open the CR from a chat prompt. Kept for that future direction.
 */
export function useCommitSessionChanges(options?: { workspaceId?: string }) {
  const ctx = useWorkspaceContext();
  const qc = useQueryClient();
  const workspaceId = options?.workspaceId ?? ctx?.workspaceId ?? '';
  return useMutation<CommitSessionResult, Error, { sessionId: string; message?: string }>({
    mutationFn: ({ sessionId, message }) =>
      commitSessionChangesRequest(workspaceId, sessionId, { message }),
    onSuccess: () => {
      // The working tree was just committed — the git-status banner and the
      // branch list (ahead/behind) are now stale.
      qc.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
      qc.invalidateQueries({ queryKey: branchKeys.list(workspaceId) });
    },
  });
}

export function useOpenChangeRequest(options?: { workspaceId?: string }) {
  const ctx = useWorkspaceContext();
  const workspaceId = options?.workspaceId ?? ctx?.workspaceId ?? '';
  const invalidate = useInvalidateAll(workspaceId);
  return useMutation<
    WorkspaceChangeRequest,
    Error,
    { title: string; description?: string; head_ref: string; base_ref?: string; session_id?: string }
  >({
    mutationFn: (input) => createChangeRequest(workspaceId, input),
    onSuccess: invalidate,
  });
}

export function useMergeChangeRequest() {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<ChangeRequestMergeResponse, Error, string>({
    mutationFn: (crId) => performMerge(workspaceId, crId),
    onSuccess: invalidate,
  });
}

export function useCloseChangeRequest() {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<WorkspaceChangeRequest, Error, string>({
    mutationFn: (crId) => performClose(workspaceId, crId),
    onSuccess: invalidate,
  });
}

export function useReopenChangeRequest() {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<WorkspaceChangeRequest, Error, string>({
    mutationFn: (crId) => performReopen(workspaceId, crId),
    onSuccess: invalidate,
  });
}

export function useRequestChangesOnChangeRequest() {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<
    { change_request: WorkspaceChangeRequest; delivering: boolean },
    Error,
    { crId: string; feedback: string }
  >({
    mutationFn: ({ crId, feedback }) => performRequestChanges(workspaceId, crId, feedback),
    onSuccess: invalidate,
  });
}
