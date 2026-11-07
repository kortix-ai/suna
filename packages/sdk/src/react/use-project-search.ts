'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type ProjectSearchInput, searchWorkspace } from '../core/rest/projects-client/project-search';
import { contract } from './query-contracts';
import { qk } from './query-keys';

type Id = string | null | undefined;

/**
 * Search the project's Files by name and text, with the caller's folder
 * access (`searchProject`). Enabled only while `q` has 1-200 characters after
 * trimming (the route answers 400 outside that range); the previous hits stay
 * while the next query loads. Debounce the input in the host: every distinct
 * `q` is one request. Pass `enabled: false` while the project's Files
 * (`drives`) are off: the route answers 403 then.
 */
export function useWorkspaceSearch(projectId: Id, input: ProjectSearchInput, options?: { enabled?: boolean }) {
  const query = { ...input, q: input.q.trim() };
  return useQuery({
    queryKey: qk.project.search(projectId ?? '', query),
    queryFn: () => searchWorkspace(projectId as string, query),
    enabled: !!projectId && (options?.enabled ?? true) && query.q.length >= 1 && query.q.length <= 200,
    placeholderData: keepPreviousData,
    ...contract('inventory'),
  });
}

/** @deprecated Use `useWorkspaceSearch`. Kept permanently. */
export const useProjectSearch = useWorkspaceSearch;
