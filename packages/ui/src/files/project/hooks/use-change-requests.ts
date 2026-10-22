'use client';

import { gitStatusKeys } from '../../runtime/hooks/use-git-status';
import { qk } from '@kortix/sdk/react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
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
  performRequestChanges,
  type ChangeRequest,
  type ChangeRequestDetailResponse,
  type ChangeRequestDiffResponse,
  type ChangeRequestMergePreview,
  type ChangeRequestMergeResponse,
  type ChangeRequestStatus,
  type VersionDiffPreview,
} from '../api/change-requests';
import { useProjectContext } from '../context';
import { branchKeys } from './use-branches';
import { commitKeys } from './use-commits';

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
  /** One session's change requests, every status. Nested under `listScope`,
   *  so each project and list invalidation reaches it as well. */
  sessionList: (projectId: string, sessionId: string) =>
    ['project-files', 'change-requests', projectId, 'list', 'session', sessionId] as const,
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
 * more than one of them. The panel's own entry is paged (`useChangeRequestPages`,
 * `{ pages, pageParams }`) and sits in the same scope, so both shapes count.
 */
type ChangeRequestList = { change_requests: ChangeRequest[] };
export type CachedListEntry = readonly [
  readonly unknown[],
  ChangeRequestList | InfiniteData<ChangeRequestList> | undefined,
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
    const rows = !data
      ? []
      : 'pages' in data
        ? data.pages.flatMap((page) => page.change_requests)
        : data.change_requests;
    const cr = rows.find((row) => row.cr_id === crId);
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
    qc.getQueriesData<CachedListEntry[1]>({
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

/**
 * How many open change requests the count badge and the command palette read
 * (one shared entry). `CountBadge` shows 99+ above 99, so 100 rows keep the
 * badge exact while the read stays bounded (KRTX-2316).
 */
export const OPEN_CHANGE_REQUESTS_LIMIT = 100;

/** The key and read of that shared entry. Every reader spreads this: a reader
 *  with its own `queryFn` and no limit writes a 50-row page over the others. */
export const openChangeRequestListQuery = (projectId: string) => ({
  queryKey: changeRequestKeys.list(projectId, 'open'),
  queryFn: () => fetchChangeRequests(projectId, 'open', { limit: OPEN_CHANGE_REQUESTS_LIMIT }),
});

/** The open change requests the count badge reads (`OPEN_CHANGE_REQUESTS_LIMIT`). */
export function useOpenChangeRequestList(options?: { refetchInterval?: number }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useQuery<{ change_requests: ChangeRequest[] }>({
    ...openChangeRequestListQuery(projectId),
    enabled: Boolean(projectId),
    staleTime: 5_000,
    refetchInterval: options?.refetchInterval,
  });
}

/**
 * One status of the project's change requests, a page (50) at a time: the
 * panel loads the next with `fetchNextPage` while `hasNextPage` is true.
 */
export function useChangeRequestPages(
  status: ChangeRequestStatus | 'all' = 'all',
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useInfiniteQuery({
    queryKey: [...changeRequestKeys.list(projectId, status), 'pages'],
    queryFn: ({ pageParam }) => fetchChangeRequests(projectId, status, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: Boolean(projectId) && options?.enabled !== false,
    staleTime: 5_000,
    refetchInterval: options?.refetchInterval,
  });
}

/**
 * The change requests ONE session opened, filtered by the server. A session's
 * outcome cards poll this every 60 s per open thread; the unfiltered project
 * list they used to poll measured 565 KB on prod.
 */
export function useSessionChangeRequests(
  sessionId: string | undefined,
  options?: { refetchInterval?: number },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  return useQuery<{ change_requests: ChangeRequest[] }>({
    queryKey: changeRequestKeys.sessionList(projectId, sessionId ?? ''),
    queryFn: () => fetchChangeRequests(projectId, 'all', { originSessionId: sessionId }),
    enabled: Boolean(projectId) && Boolean(sessionId),
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
 * Marks every change-request read of one project stale: each list (the
 * session's outcome cards, the sidebar brief), each detail, and the review
 * summary behind the sidebar's "Needs you" count. Called at turn end, because
 * an agent opens and closes change requests from its sandbox through the REST
 * API and the browser is not told (KRTX-3009, KRTX-3010).
 */
export function invalidateChangeRequestReads(qc: QueryClient, projectId: string): void {
  if (!projectId) return;
  qc.invalidateQueries({ queryKey: changeRequestKeys.project(projectId) });
  qc.invalidateQueries({ queryKey: qk.project.reviewSummary(projectId) });
}

/**
 * Invalidates every CR query for the active project — used after open / merge
 * / close / reopen so all panels and detail views re-fetch.
 */
export function invalidateAfterChangeRequestWrite(qc: QueryClient, projectId: string): void {
  invalidateChangeRequestReads(qc, projectId);
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
  // A merged CR can rewrite kortix.yaml: add or remove agents and change
  // `default_agent`. Both live in the project detail entry, and the composer's
  // agent list sits under it (`[...detail, 'agents']`), so New session kept
  // offering removed agents until a reload (KRTX-3012).
  qc.invalidateQueries({ queryKey: qk.project.detail(projectId) });
}

function useInvalidateAll(projectIdArg?: string) {
  const qc = useQueryClient();
  const ctx = useProjectContext();
  const projectId = projectIdArg ?? ctx?.projectId ?? '';
  return () => invalidateAfterChangeRequestWrite(qc, projectId);
}

export function useOpenChangeRequest(options?: { projectId?: string }) {
  const ctx = useProjectContext();
  const projectId = options?.projectId ?? ctx?.projectId ?? '';
  const invalidate = useInvalidateAll(projectId);
  return useMutation<
    ChangeRequest,
    Error,
    {
      title: string;
      description?: string;
      head_ref: string;
      base_ref?: string;
      session_id?: string;
    }
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
