'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Craft,
  type CraftListing,
  type CraftRunListing,
  type CraftRunReport,
  type InstalledCraftListing,
  type ListCraftRunsOptions,
  type ListCraftsOptions,
  createCraftAuthorSession,
  createCraftInstallSession,
  createCraftUninstallSession,
  deleteCraft,
  getCraft,
  listCraftRuns,
  listCrafts,
  listProjectCraftRuns,
  listProjectCrafts,
  setCraftActivation,
  submitCraft,
  submitCraftArchive,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable key factories — reuse to read or invalidate the same cache entries. */
export const craftsKey = (options?: ListCraftsOptions) => qk.crafts.list(options);
export const craftKey = (craftId: string) => qk.crafts.detail(craftId);
export const projectCraftsKey = (projectId: string | null | undefined) =>
  qk.project.crafts(projectId ?? '');
export const craftRunsKey = (
  projectId: string | null | undefined,
  slug: string | null | undefined,
) => qk.project.craftRuns(projectId ?? '', slug ?? '');
export const projectCraftRunsKey = (projectId: string | null | undefined) =>
  qk.project.craftRunsAll(projectId ?? '');

/**
 * The craft store. Browse plus submit (from a repo or an uploaded `.zip`) and
 * withdraw.
 *
 * Submitting invalidates the store listing so a freshly indexed craft appears
 * without a manual refetch.
 */
export function useCrafts(options?: ListCraftsOptions) {
  const queryClient = useQueryClient();
  const queryKey = craftsKey(options);
  const invalidateStore = () => queryClient.invalidateQueries({ queryKey: qk.crafts.scope() });

  const query = useQuery<CraftListing>({
    queryKey,
    queryFn: () => listCrafts(options),
    // No project needed — the store is account-scoped.
    ...contract('config'),
  });

  const submit = useMutation({
    mutationFn: (input: Parameters<typeof submitCraft>[0]) => submitCraft(input),
    onSuccess: invalidateStore,
  });

  const submitArchive = useMutation({
    mutationFn: (input: Parameters<typeof submitCraftArchive>[0]) => submitCraftArchive(input),
    onSuccess: invalidateStore,
  });

  const remove = useMutation({
    mutationFn: (craftId: string) => deleteCraft(craftId),
    onSuccess: invalidateStore,
  });

  return { ...query, submit, submitArchive, remove, invalidate: invalidateStore };
}

/** One craft's detail. */
export function useCraft(craftId: string | null | undefined) {
  return useQuery<Craft>({
    queryKey: craftKey(craftId ?? ''),
    queryFn: () => getCraft(craftId as string),
    enabled: !!craftId,
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
export function useProjectCrafts(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectCraftsKey(projectId);

  const query = useQuery<InstalledCraftListing>({
    queryKey,
    queryFn: () => listProjectCrafts(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });

  const install = useMutation({
    mutationFn: (craftId: string) => createCraftInstallSession(projectId as string, craftId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // The store card carries an install count and an installed pill, so a
      // stale store would offer "Install" on a craft just installed.
      queryClient.invalidateQueries({ queryKey: qk.crafts.scope() });
    },
  });

  const uninstall = useMutation({
    mutationFn: (slug: string) => createCraftUninstallSession(projectId as string, slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // Removing a craft removes its runs from the report.
      queryClient.invalidateQueries({
        queryKey: qk.project.craftRunsScope(projectId ?? ''),
      });
    },
  });

  /**
   * Describe a craft and have one built. Returns a SESSION like the other two —
   * nothing is published when this resolves.
   *
   * It does NOT invalidate the installed list: an authoring session produces a
   * craft in the STORE, and installing it into a project is a separate step the
   * person takes afterwards.
   */
  const author = useMutation({
    mutationFn: (description: string) =>
      createCraftAuthorSession(projectId as string, description),
  });

  /**
   * Enable or disable one craft's triggers.
   *
   * Invalidates the project's TRIGGERS as well as its crafts: this writes the
   * manifest, so the triggers page is showing stale `enabled` values the moment
   * it resolves. That is the one thing a caller cannot be expected to know.
   */
  const setActivation = useMutation({
    mutationFn: (input: { slug: string; enabled: boolean }) =>
      setCraftActivation(projectId as string, input.slug, input.enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: qk.project.triggers(projectId ?? '') });
    },
  });

  return { ...query, install, uninstall, author, setActivation };
}

/** Runs across every installed craft, newest first. */
export function useProjectCraftRuns(
  projectId: string | null | undefined,
  options?: ListCraftRunsOptions,
) {
  return useQuery<CraftRunListing>({
    queryKey: projectCraftRunsKey(projectId),
    queryFn: () => listProjectCraftRuns(projectId as string, options),
    enabled: !!projectId,
    // `inventory`, not `config`: a run list changes whenever a trigger fires,
    // which is on the craft's schedule and not on any user action here.
    ...contract('inventory'),
  });
}

/** One craft's runs, with aggregate stats. */
export function useCraftRuns(
  projectId: string | null | undefined,
  slug: string | null | undefined,
  options?: ListCraftRunsOptions,
) {
  return useQuery<CraftRunReport>({
    queryKey: craftRunsKey(projectId, slug),
    queryFn: () => listCraftRuns(projectId as string, slug as string, options),
    enabled: !!projectId && !!slug,
    ...contract('inventory'),
  });
}
