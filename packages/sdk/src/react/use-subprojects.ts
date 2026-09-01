'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Subproject,
  type SubprojectListing,
  type SubprojectRunListing,
  type SubprojectRunReport,
  type InstalledSubprojectListing,
  type ListSubprojectRunsOptions,
  type ListSubprojectsOptions,
  createSubprojectAuthorSession,
  createSubprojectInstallSession,
  createSubprojectUninstallSession,
  deleteSubproject,
  getSubproject,
  listSubprojectRuns,
  listSubprojects,
  listProjectSubprojectRuns,
  listProjectSubprojects,
  setSubprojectActivation,
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
export const subprojectRunsKey = (
  projectId: string | null | undefined,
  slug: string | null | undefined,
) => qk.project.subprojectRuns(projectId ?? '', slug ?? '');
export const projectSubprojectRunsKey = (projectId: string | null | undefined) =>
  qk.project.subprojectRunsAll(projectId ?? '');

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
    mutationFn: (input: Parameters<typeof submitSubprojectArchive>[0]) => submitSubprojectArchive(input),
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
    mutationFn: (subprojectId: string) => createSubprojectInstallSession(projectId as string, subprojectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // The store card carries an install count and an installed pill, so a
      // stale store would offer "Install" on a subproject just installed.
      queryClient.invalidateQueries({ queryKey: qk.subprojects.scope() });
    },
  });

  const uninstall = useMutation({
    mutationFn: (slug: string) => createSubprojectUninstallSession(projectId as string, slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // Removing a subproject removes its runs from the report.
      queryClient.invalidateQueries({
        queryKey: qk.project.subprojectRunsScope(projectId ?? ''),
      });
    },
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

  /**
   * Enable or disable one subproject's triggers.
   *
   * Invalidates the project's TRIGGERS as well as its subprojects: this writes the
   * manifest, so the triggers page is showing stale `enabled` values the moment
   * it resolves. That is the one thing a caller cannot be expected to know.
   */
  const setActivation = useMutation({
    mutationFn: (input: { slug: string; enabled: boolean }) =>
      setSubprojectActivation(projectId as string, input.slug, input.enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: qk.project.triggers(projectId ?? '') });
    },
  });

  return { ...query, install, uninstall, author, setActivation };
}

/** Runs across every installed subproject, newest first. */
export function useProjectSubprojectRuns(
  projectId: string | null | undefined,
  options?: ListSubprojectRunsOptions,
) {
  return useQuery<SubprojectRunListing>({
    queryKey: projectSubprojectRunsKey(projectId),
    queryFn: () => listProjectSubprojectRuns(projectId as string, options),
    enabled: !!projectId,
    // `inventory`, not `config`: a run list changes whenever a trigger fires,
    // which is on the subproject's schedule and not on any user action here.
    ...contract('inventory'),
  });
}

/** One subproject's runs, with aggregate stats. */
export function useSubprojectRuns(
  projectId: string | null | undefined,
  slug: string | null | undefined,
  options?: ListSubprojectRunsOptions,
) {
  return useQuery<SubprojectRunReport>({
    queryKey: subprojectRunsKey(projectId, slug),
    queryFn: () => listSubprojectRuns(projectId as string, slug as string, options),
    enabled: !!projectId && !!slug,
    ...contract('inventory'),
  });
}
