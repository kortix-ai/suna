'use client';

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addProjectMemoryNote,
  createProjectMemoryPage,
  deleteProjectMemoryPage,
  getProjectMemoryLayer,
  getProjectMemoryPage,
  getSessionMemoryUsage,
  listProjectMemoryChanges,
  listProjectMemoryHistory,
  listProjectMemoryPages,
  restoreProjectMemoryPage,
  searchProjectMemory,
  undoProjectMemoryVersion,
  updateProjectMemoryPage,
  type AddProjectMemoryNoteInput,
  type CreateProjectMemoryPageInput,
  type ProjectMemoryPage,
  type ProjectMemorySearchInput,
  type SessionMemoryUsage,
  type UpdateProjectMemoryPageInput,
} from '../core/rest/projects-client/memory';
import { contract } from './query-contracts';
import { qk } from './query-keys';

// Memory pages (`project_channels`). People and agents both write them, so
// every read is the `inventory` tier. Pass `enabled: false` while the
// project's `project_channels` flag is off: every route answers 403 then.

type Id = string | null | undefined;
type ReadOptions = { enabled?: boolean };

const on = (options: ReadOptions | undefined, ...ids: Id[]) => ids.every(Boolean) && (options?.enabled ?? true);

/** One layer (`company` or a space id) with its page counts, `read_only` and `can_write`. */
export function useProjectMemoryLayer(projectId: Id, layerKey: Id, options?: ReadOptions) {
  return useQuery({
    queryKey: qk.project.memoryLayer(projectId ?? '', layerKey ?? ''),
    queryFn: () => getProjectMemoryLayer(projectId as string, layerKey as string),
    enabled: on(options, projectId, layerKey),
    ...contract('inventory'),
  });
}

/** The layer's live pages, without bodies. */
export function useProjectMemoryPages(projectId: Id, layerKey: Id, options?: ReadOptions) {
  return useQuery({
    queryKey: qk.project.memoryPages(projectId ?? '', layerKey ?? ''),
    queryFn: () => listProjectMemoryPages(projectId as string, layerKey as string),
    enabled: on(options, projectId, layerKey),
    ...contract('inventory'),
  });
}

/** The layer's Recent changes, newest first. `fetchNextPage()` loads older ones while `hasNextPage`. */
export function useProjectMemoryChanges(projectId: Id, layerKey: Id, options?: ReadOptions) {
  return useInfiniteQuery({
    queryKey: qk.project.memoryChanges(projectId ?? '', layerKey ?? ''),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listProjectMemoryChanges(projectId as string, layerKey as string, { before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { next: string | null }) => last.next ?? undefined,
    enabled: on(options, projectId, layerKey),
    ...contract('inventory'),
  });
}

/** One page with its body and sources. */
export function useProjectMemoryPage(projectId: Id, pageId: Id, options?: ReadOptions) {
  return useQuery({
    queryKey: qk.project.memoryPage(projectId ?? '', pageId ?? ''),
    queryFn: () => getProjectMemoryPage(projectId as string, pageId as string),
    enabled: on(options, projectId, pageId),
    ...contract('inventory'),
  });
}

/** One page's versions, newest first. `fetchNextPage()` loads older ones while `hasNextPage`. */
export function useProjectMemoryHistory(projectId: Id, pageId: Id, options?: ReadOptions) {
  return useInfiniteQuery({
    queryKey: qk.project.memoryHistory(projectId ?? '', pageId ?? ''),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listProjectMemoryHistory(projectId as string, pageId as string, { before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { next: string | null }) => last.next ?? undefined,
    enabled: on(options, projectId, pageId),
    ...contract('inventory'),
  });
}

/**
 * Search the pages the caller can read. Disabled until `q` has 2 characters
 * after trimming; the previous hits stay while the next query loads. Debounce
 * the input in the host: every distinct `q` is one request.
 */
export function useProjectMemorySearch(projectId: Id, input: ProjectMemorySearchInput, options?: ReadOptions) {
  const query = { ...input, q: input.q.trim() };
  return useQuery({
    queryKey: qk.project.memorySearch(projectId ?? '', query),
    queryFn: () => searchProjectMemory(projectId as string, query),
    enabled: on(options, projectId) && query.q.length >= 2,
    placeholderData: keepPreviousData,
    ...contract('inventory'),
  });
}

/**
 * A thread's "Used memory": the pages its agent was given at the first turn.
 * Fixed once `loaded_at` is set, so it never refetches after that; while
 * `loaded_at` is null (no turn yet) the next mount or focus reads it again.
 */
export function useSessionMemoryUsage(projectId: Id, sessionId: Id, options?: ReadOptions) {
  return useQuery({
    queryKey: qk.project.sessionMemoryUsage(projectId ?? '', sessionId ?? ''),
    queryFn: () => getSessionMemoryUsage(projectId as string, sessionId as string),
    enabled: on(options, projectId, sessionId),
    ...contract('inventory'),
    staleTime: (query: { state: { data?: SessionMemoryUsage } }) => (query.state.data?.loaded_at ? Infinity : 0),
  });
}

// Every memory mutation sets this hook-level `onError`. The caller shows its
// own message per code (`version_conflict`, `secret_detected`, …) in the
// call-time `onError`; without a hook-level one, TanStack also runs the
// QueryClient's default mutation `onError`, a second, generic error toast.
const callerShowsError = () => {};

/**
 * After a memory write: put the pages the response returned into their slots,
 * then refetch every memory read of the project (layer counts, page lists,
 * Recent changes, pages, history) and the channel tab counts.
 */
function useMemoryWritten(projectId: string) {
  const queryClient = useQueryClient();
  return (pages: ProjectMemoryPage[] = []) => {
    for (const page of pages) queryClient.setQueryData(qk.project.memoryPage(projectId, page.page_id), page);
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.memory(projectId) }),
      queryClient.invalidateQueries({ queryKey: qk.project.spaceSummaries(projectId) }),
    ]);
  };
}

/** Create a page in a layer. Rejects with `ApiError` codes as `createProjectMemoryPage` does. */
export function useCreateProjectMemoryPage(projectId: string, layerKey: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (input: CreateProjectMemoryPageInput) => createProjectMemoryPage(projectId, layerKey, input),
    onError: callerShowsError,
    onSuccess: () => written(),
  });
}

/** Save a Remember-box sentence as a `note` page in a layer. */
export function useAddProjectMemoryNote(projectId: string, layerKey: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (input: AddProjectMemoryNoteInput) => addProjectMemoryNote(projectId, layerKey, input),
    onError: callerShowsError,
    onSuccess: () => written(),
  });
}

/** Edit a page. A stale `base_version` rejects with `ApiError` code `version_conflict`. */
export function useUpdateProjectMemoryPage(projectId: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (args: { pageId: string; input: UpdateProjectMemoryPageInput }) =>
      updateProjectMemoryPage(projectId, args.pageId, args.input),
    onError: callerShowsError,
    onSuccess: (page: ProjectMemoryPage) => written([page]),
  });
}

/** Move a page to the trash. Resolves `{ ok, version_id }`: pass `version_id` to undo it. */
export function useDeleteProjectMemoryPage(projectId: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (pageId: string) => deleteProjectMemoryPage(projectId, pageId),
    onError: callerShowsError,
    onSuccess: () => written(),
  });
}

/** Make an older version the page's content again. */
export function useRestoreProjectMemoryPage(projectId: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (args: { pageId: string; versionId: string }) =>
      restoreProjectMemoryPage(projectId, args.pageId, args.versionId),
    onError: callerShowsError,
    onSuccess: (page: ProjectMemoryPage) => written([page]),
  });
}

/**
 * Undo one change by any of its versions (from Recent changes, history, or a
 * thread's "Saved to memory" line). Rejects with `ApiError` code `superseded`
 * or `already_undone`.
 */
export function useUndoProjectMemoryVersion(projectId: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (versionId: string) => undoProjectMemoryVersion(projectId, versionId),
    onError: callerShowsError,
    onSuccess: (result: { pages: ProjectMemoryPage[] }) => written(result.pages),
  });
}
