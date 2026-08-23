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
  type ChangeRequest,
  type ChangeRequestDetailResponse,
  type ChangeRequestDiffResponse,
  type ChangeRequestMergePreview,
  type ChangeRequestMergeResponse,
  type ChangeRequestStatus,
  type CommitSessionResult,
  type VersionDiffPreview,
} from '../api/change-requests';
import { useProjectContext } from '../context';
import { gitStatusKeys } from '@/features/files/hooks/use-git-status';
import { branchKeys } from './use-branches';
import { commitKeys } from './use-commits';
import { qk } from '@kortix/sdk/react';

export const changeRequestKeys = {
  all: ['project-files', 'change-requests'] as const,
  /** Project-scoped, status-agnostic prefix — every CR list/detail/diff/preview
   *  for one project, regardless of status. Used for "something about this
   *  project's CRs changed" invalidation; `all` above is unscoped (every
   *  project) and too broad for that. */
  project: (projectId: string) => ['project-files', 'change-requests', projectId] as const,
  /** Every status bucket for one project — the prefix `list` nests under. */
  listScope: (projectId: string) =>
    ['project-files', 'change-requests', projectId, 'list'] as const,
  list: (projectId: string, status: ChangeRequestStatus | 'all') =>
    ['project-files', 'change-requests', projectId, 'list', status] as const,
  detail: (projectId: string, crId: string) =>
    ['project-files', 'change-requests', projectId, crId] as const,
  diff: (projectId: string, crId: string) =>
    ['project-files', 'change-requests', projectId, crId, 'diff'] as const,
  preview: (projectId: string, crId: string) =>
    ['project-files', 'change-requests', projectId, crId, 'merge-preview'] as const,
};

/**
 * `useVersionDiff`'s key family — kept local (not exported elsewhere) since
 * this is its only reader/invalidator.
 */
const versionDiffKeys = {
  project: (projectId: string) => ['project-files', 'version-diff', projectId] as const,
  diff: (projectId: string, from: string, into: string) =>
    ['project-files', 'version-diff', projectId, from, into] as const,
  idle: ['project-files', 'version-diff', 'idle'] as const,
};

/**
 * The `ChangeRequest` for `crId` already sitting in a cached LIST response.
 *
 * `ChangeRequestDetailResponse` is `{ change_request: ChangeRequest }` and the
 * list endpoint returns those very objects — same server, same shape, one
 * request earlier. So a CR opened from a loaded list needs no round trip to
 * paint; the detail fetch becomes a background refresh instead of a gate.
 *
 * Scans every status bucket (`open` / `merged` / `closed` / `all`), because the
 * panel's filter decides which list is populated and a CR can be reached from
 * more than one of them.
 */
export type CachedListEntry = readonly [
  readonly unknown[],
  { change_requests: ChangeRequest[] } | undefined,
];

/**
 * Find `crId` in a set of cached list responses, and say WHICH list it came
 * from.
 *
 * Pure so the lookup can be tested without a QueryClient. The key matters as
 * much as the hit: the seed's `initialDataUpdatedAt` has to be that list's
 * timestamp (see the caller), so the function that finds the row is the one
 * that must report where it found it.
 */
export function findCachedChangeRequest(
  entries: readonly CachedListEntry[],
  crId: string,
): { cr: ChangeRequest; key: readonly unknown[] } | undefined {
  if (!crId) return undefined;
  for (const [key, data] of entries) {
    const cr = data?.change_requests.find((row) => row.cr_id === crId);
    if (cr) return { cr, key };
  }
  return undefined;
}

function cachedChangeRequest(
  qc: ReturnType<typeof useQueryClient>,
  projectId: string,
  crId: string,
): { data: ChangeRequestDetailResponse; updatedAt: number } | undefined {
  if (!projectId || !crId) return undefined;
  const hit = findCachedChangeRequest(
    qc.getQueriesData<{ change_requests: ChangeRequest[] }>({
      queryKey: changeRequestKeys.listScope(projectId),
    }),
    crId,
  );
  if (!hit) return undefined;
  return {
    data: { change_request: hit.cr },
    // The LIST's timestamp, not `Date.now()`. Passing "fresh right now" would
    // suppress the background refetch for `staleTime`, so a CR whose status
    // changed server-side would show the stale row until the poll caught up.
    updatedAt: qc.getQueryState(hit.key)?.dataUpdatedAt ?? 0,
  };
}

/**
 * Warm a change request's detail + diff before it is opened.
 *
 * The diff is the expensive half and the only thing the dialog genuinely has
 * to wait for, so starting it on pointer-enter buys the ~150-300ms of hover
 * before the click lands. Both are plain `prefetchQuery` calls: they respect
 * `staleTime`, so re-hovering the same row costs nothing.
 */
export function usePrefetchChangeRequest() {
  const qc = useQueryClient();
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return (crId: string) => {
    if (!projectId || !crId) return;
    void qc.prefetchQuery({
      queryKey: changeRequestKeys.detail(projectId, crId),
      queryFn: () => fetchChangeRequest(projectId, crId),
      staleTime: 5_000,
    });
    void qc.prefetchQuery({
      queryKey: changeRequestKeys.diff(projectId, crId),
      queryFn: () => fetchChangeRequestDiff(projectId, crId),
      staleTime: 10_000,
    });
  };
}

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
  const qc = useQueryClient();
  const projectId = ctx?.projectId ?? '';
  const seed = crId ? cachedChangeRequest(qc, projectId, crId) : undefined;
  return useQuery<ChangeRequestDetailResponse>({
    queryKey: crId
      ? changeRequestKeys.detail(projectId, crId)
      : ['project-files', 'change-requests', 'idle'],
    queryFn: () => fetchChangeRequest(projectId, crId as string),
    enabled: Boolean(projectId && crId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: 8_000,
    // Opening a CR from the panel paints its header on the click frame. The
    // dialog's merge-preview query is gated on `status === 'open'`, so this
    // also breaks a detail -> preview waterfall into two parallel requests.
    initialData: seed?.data,
    initialDataUpdatedAt: seed?.updatedAt,
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
  options?: { enabled?: boolean; projectId?: string },
) {
  const ctx = useProjectContext();
  const projectId = options?.projectId ?? ctx?.projectId ?? '';
  const canRun = Boolean(projectId && input?.from && input?.into);
  return useQuery<VersionDiffPreview>({
    queryKey: canRun
      ? versionDiffKeys.diff(projectId, input!.from, input!.into)
      : versionDiffKeys.idle,
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
function useInvalidateAll(projectIdArg?: string) {
  const qc = useQueryClient();
  const ctx = useProjectContext();
  const projectId = projectIdArg ?? ctx?.projectId ?? '';
  return () => {
    qc.invalidateQueries({ queryKey: changeRequestKeys.project(projectId) });
    // Branches list shows ahead/behind that may shift after a merge.
    qc.invalidateQueries({ queryKey: branchKeys.list(projectId) });
    // The merge commit lands on the default branch — commit list goes stale.
    qc.invalidateQueries({ queryKey: commitKeys.project(projectId) });
    // Whether this version still differs from its base changes the moment a CR
    // merges — refresh the "Alternate version of main · N changes" banner
    // (git-status, which is otherwise sticky and never re-fetches on its own),
    // the live version-diff preview, and the cached session row (base_ref etc.).
    qc.invalidateQueries({ queryKey: gitStatusKeys.all });
    qc.invalidateQueries({ queryKey: versionDiffKeys.project(projectId) });
    // Every individual git-connected session under this project — a CR
    // landing on the base ref can change what `getProjectSession` returns
    // (base_ref etc.) for any of them. sessionsScope is the shared prefix
    // that reaches the sessions list AND every qk.project.session(id, sid)
    // entry in one call; there is no "every session, not the list" prefix to
    // narrow to, so this deliberately also refreshes the sessions list.
    qc.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    // Landing a CR on the base ref is the one thing that happens INSIDE the app
    // that can make an open session's compiled agent config stale. The
    // freshness query is deliberately not polled — this is what tells it to
    // look again, so the chip appears on merge rather than on next focus.
    qc.invalidateQueries({ queryKey: ['session-config', projectId] });
  };
}

/**
 * Commit + push the session sandbox's pending changes to its branch.
 *
 * NOTE (2026-05-29): currently UNUSED. Built for a one-click fully-UI "Open
 * change request" flow; the shipped flow instead asks the agent to commit +
 * open the CR from a chat prompt. Kept for that future direction.
 */
export function useCommitSessionChanges(options?: { projectId?: string }) {
  const ctx = useProjectContext();
  const qc = useQueryClient();
  const projectId = options?.projectId ?? ctx?.projectId ?? '';
  return useMutation<CommitSessionResult, Error, { sessionId: string; message?: string }>({
    mutationFn: ({ sessionId, message }) =>
      commitSessionChangesRequest(projectId, sessionId, { message }),
    onSuccess: () => {
      // The working tree was just committed — the git-status banner and the
      // branch list (ahead/behind) are now stale.
      qc.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
      qc.invalidateQueries({ queryKey: branchKeys.list(projectId) });
    },
  });
}

export function useOpenChangeRequest(options?: { projectId?: string }) {
  const ctx = useProjectContext();
  const projectId = options?.projectId ?? ctx?.projectId ?? '';
  const invalidate = useInvalidateAll(projectId);
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

export function useRequestChangesOnChangeRequest() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const invalidate = useInvalidateAll();
  return useMutation<
    { change_request: ChangeRequest; delivering: boolean },
    Error,
    { crId: string; feedback: string }
  >({
    mutationFn: ({ crId, feedback }) => performRequestChanges(projectId, crId, feedback),
    onSuccess: invalidate,
  });
}
