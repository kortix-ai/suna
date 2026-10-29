'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addProjectMemoryNote,
  deleteProjectMemoryPage,
  getProjectMemoryLayer,
  getProjectMemoryPage,
  getSessionMemoryUsage,
  listProjectMemoryHistory,
  listProjectMemoryPages,
  searchProjectMemory,
  updateProjectMemoryPage,
  type AddProjectMemoryNoteInput,
  type ProjectMemoryPage,
  type ProjectMemoryPageListOptions,
  type ProjectMemorySearchInput,
  type SessionMemoryUsage,
  type UpdateProjectMemoryPageInput,
} from '../core/rest/projects-client/memory';
import { contract } from './query-contracts';
import { qk } from './query-keys';

// Memory: the Markdown files of the project's Drive. People and agents both
// write them, so every read is the `inventory` tier. Pass `enabled: false`
// while the project's Files (`drives`) are off: every route answers 403 then.
// The Memory UI is a Channels surface: hosts also gate it on `project_channels`.

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

/**
 * The layer's pages (one per Markdown file), without bodies. Each filter has
 * its own cache slot, and every memory write refreshes them all.
 */
export function useProjectMemoryPages(
  projectId: Id,
  layerKey: Id,
  options?: ReadOptions & ProjectMemoryPageListOptions,
) {
  const filter: ProjectMemoryPageListOptions = { type: options?.type };
  return useQuery({
    queryKey: qk.project.memoryPages(projectId ?? '', layerKey ?? '', filter),
    queryFn: () => listProjectMemoryPages(projectId as string, layerKey as string, filter),
    enabled: on(options, projectId, layerKey),
    ...contract('inventory'),
  });
}

/** One page with its body and front-matter sources. */
export function useProjectMemoryPage(projectId: Id, pageId: Id, options?: ReadOptions) {
  return useQuery({
    queryKey: qk.project.memoryPage(projectId ?? '', pageId ?? ''),
    queryFn: () => getProjectMemoryPage(projectId as string, pageId as string),
    enabled: on(options, projectId, pageId),
    ...contract('inventory'),
  });
}

/** One page's versions from Drive commits, newest first, at most 20. Older ones are in Files → Versions. */
export function useProjectMemoryHistory(projectId: Id, pageId: Id, options?: ReadOptions) {
  return useQuery({
    queryKey: qk.project.memoryHistory(projectId ?? '', pageId ?? ''),
    queryFn: () => listProjectMemoryHistory(projectId as string, pageId as string),
    enabled: on(options, projectId, pageId),
    ...contract('inventory'),
  });
}

/**
 * Search the pages the caller can read. Enabled only while `q` has 2–200
 * characters after trimming (the route answers 400 outside that range); the
 * previous hits stay while the next query loads, also when `q` drops below 2,
 * so render hits only for a valid `q`. Debounce the input in the host: every
 * distinct `q` is one request.
 */
export function useProjectMemorySearch(projectId: Id, input: ProjectMemorySearchInput, options?: ReadOptions) {
  const query = { ...input, q: input.q.trim() };
  return useQuery({
    queryKey: qk.project.memorySearch(projectId ?? '', query),
    queryFn: () => searchProjectMemory(projectId as string, query),
    enabled: on(options, projectId) && query.q.length >= 2 && query.q.length <= 200,
    placeholderData: keepPreviousData,
    ...contract('inventory'),
  });
}

/**
 * A thread's "Used memory": the files its agent was listed at the first turn.
 * Fixed once `loaded_at` is set, so it never refetches after that; while
 * `loaded_at` is null (no turn yet) the next mount reads it again.
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
 * pages, history) and the onboarding state (memory saved in `#general` completes a "Get started" row).
 */
function useMemoryWritten(projectId: string) {
  const queryClient = useQueryClient();
  return (pages: ProjectMemoryPage[] = []) => {
    for (const page of pages) queryClient.setQueryData(qk.project.memoryPage(projectId, page.page_id), page);
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.memory(projectId) }),
      queryClient.invalidateQueries({ queryKey: qk.project.channelsOnboarding(projectId) }),
    ]);
  };
}

/** Append a Remember-box sentence to a layer's `Notes.md`. */
export function useAddProjectMemoryNote(projectId: string, layerKey: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (input: AddProjectMemoryNoteInput) => addProjectMemoryNote(projectId, layerKey, input),
    onError: callerShowsError,
    onSuccess: () => written(),
  });
}

/** Replace a page's body. A stale `base_version` rejects with `ApiError` code `version_conflict`. */
export function useUpdateProjectMemoryPage(projectId: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (args: { pageId: string; input: UpdateProjectMemoryPageInput }) =>
      updateProjectMemoryPage(projectId, args.pageId, args.input),
    onError: callerShowsError,
    onSuccess: (page: ProjectMemoryPage) => written([page]),
  });
}

/** Delete a page's file for good. Resolves `{ ok, version_id }`. */
export function useDeleteProjectMemoryPage(projectId: string) {
  const written = useMemoryWritten(projectId);
  return useMutation({
    mutationFn: (pageId: string) => deleteProjectMemoryPage(projectId, pageId),
    onError: callerShowsError,
    onSuccess: () => written(),
  });
}
