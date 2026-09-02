'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Subproject,
  type SubprojectListing,
  type InstalledSubprojectListing,
  type ListSubprojectsOptions,
  createSubprojectAuthorSession,
  createSubprojectInstallSession,
  createSubprojectUninstallSession,
  deleteSubproject,
  getSubproject,
  listSubprojects,
  listProjectSubprojects,
  submitSubproject,
  submitSubprojectArchive,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable key factories — reuse to read or invalidate the same cache entries. */
export const subprojectsKey = (options?: ListSubprojectsOptions) => qk.subprojects.list(options);
export const subprojectKey = (subprojectId: string) => qk.subprojects.detail(subprojectId);
export const projectSubprojectsKey = (projectId: string | null | undefined) =>
  qk.project.subprojects(projectId ?? '');

/**
 * The subproject store. Browse plus submit (from a repo or an uploaded `.zip`) and
 * withdraw.
 *
 * Submitting invalidates the store listing so a freshly indexed subproject appears
 * without a manual refetch.
 */
export function useSubprojects(options?: ListSubprojectsOptions) {
  const queryClient = useQueryClient();
  const queryKey = subprojectsKey(options);
  const invalidateStore = () => queryClient.invalidateQueries({ queryKey: qk.subprojects.scope() });

  const query = useQuery<SubprojectListing>({
    queryKey,
    queryFn: () => listSubprojects(options),
    // No project needed — the store is account-scoped.
    ...contract('config'),
  });

  const submit = useMutation({
    mutationFn: (input: Parameters<typeof submitSubproject>[0]) => submitSubproject(input),
    onSuccess: invalidateStore,
  });

  const submitArchive = useMutation({
    mutationFn: (input: Parameters<typeof submitSubprojectArchive>[0]) =>
      submitSubprojectArchive(input),
    onSuccess: invalidateStore,
  });

  const remove = useMutation({
    mutationFn: (subprojectId: string) => deleteSubproject(subprojectId),
    onSuccess: invalidateStore,
  });

  return { ...query, submit, submitArchive, remove, invalidate: invalidateStore };
}

/** One subproject's detail. */
export function useSubproject(subprojectId: string | null | undefined) {
  return useQuery<Subproject>({
    queryKey: subprojectKey(subprojectId ?? ''),
    queryFn: () => getSubproject(subprojectId as string),
    enabled: !!subprojectId,
    ...contract('config'),
  });
}

/**
 * What one project has installed, plus install and uninstall.
 *
 * Both mutations return a SESSION id — the agent inside it does the merge and
 * lands a change request, so neither has finished when the promise resolves.
 * That is why they invalidate rather than write optimistically: the installed
 * list changes when the CR merges, not when this call returns.
 *
 * There is no activation mutation. An installed subproject is a set of entries
 * in the manifest, not a running thing, and its triggers are enabled one at a
 * time through `useProjectTriggers` — the page that shows what each one does.
 */
export function useProjectSubprojects(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectSubprojectsKey(projectId);

  const query = useQuery<InstalledSubprojectListing>({
    queryKey,
    queryFn: () => listProjectSubprojects(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });

  const install = useMutation({
    mutationFn: (subprojectId: string) =>
      createSubprojectInstallSession(projectId as string, subprojectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // The store card carries an install count and an installed pill, so a
      // stale store would offer "Install" on a subproject just installed.
      queryClient.invalidateQueries({ queryKey: qk.subprojects.scope() });
    },
  });

  const uninstall = useMutation({
    mutationFn: (slug: string) => createSubprojectUninstallSession(projectId as string, slug),
    // Only the installed list. Uninstall removes the subproject's manifest
    // entries, and the triggers page reads triggers straight from the manifest
    // through its own key, which this session's change request invalidates when
    // it merges — not when this call resolves.
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  /**
   * Describe a subproject and have one built. Returns a SESSION like the other two —
   * nothing is published when this resolves.
   *
   * It does NOT invalidate the installed list: an authoring session produces a
   * subproject in the STORE, and installing it into a project is a separate step the
   * person takes afterwards.
   */
  const author = useMutation({
    mutationFn: (description: string) =>
      createSubprojectAuthorSession(projectId as string, description),
  });

  return { ...query, install, uninstall, author };
}
