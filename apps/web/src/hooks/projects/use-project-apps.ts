'use client';

/**
 * React Query bindings for the `/v1/projects/:id/apps/*` routes.
 *
 * One read hook (`useProjectApps`) that powers the Apps overlay list, plus
 * one mutation hook per server-state-changing action. Every mutation
 * invalidates `['project-apps', projectId]` so the overlay reflects the
 * fresh manifest + deployment state.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createProjectApp,
  deleteProjectApp,
  deployProjectApp,
  getProjectAppLogs,
  listProjectApps,
  stopProjectApp,
  updateProjectApp,
  type CreateOrUpdateProjectAppInput,
  type DeploymentStatus,
  type ListProjectAppsResponse,
} from '@/lib/projects-apps-client';

const PROJECT_APPS_KEY = (projectId: string) => ['project-apps', projectId] as const;

// Non-terminal deployment states — keep polling while any app sits in one.
const IN_PROGRESS_STATUSES = new Set<DeploymentStatus>(['pending', 'building', 'deploying']);

export function projectAppsQueryKey(projectId: string) {
  return PROJECT_APPS_KEY(projectId);
}

export function useProjectApps(projectId: string | undefined) {
  return useQuery({
    queryKey: PROJECT_APPS_KEY(projectId ?? ''),
    queryFn: () => listProjectApps(projectId!),
    enabled: !!projectId,
    // Deploys + sweeps mutate state outside the UI; keep this fresh-ish so
    // status badges don't stall on a `pending` row for minutes.
    refetchInterval: (query) => {
      const data = query.state.data as ListProjectAppsResponse | undefined;
      const anyInProgress = data?.apps.some((a) => {
        const status = a.latest_deployment?.status;
        return status != null && IN_PROGRESS_STATUSES.has(status);
      });
      return anyInProgress ? 4000 : false;
    },
  });
}

export function useCreateProjectApp(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrUpdateProjectAppInput) => createProjectApp(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROJECT_APPS_KEY(projectId) }),
  });
}

export function useUpdateProjectApp(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; input: Partial<CreateOrUpdateProjectAppInput> }) =>
      updateProjectApp(projectId, vars.slug, vars.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROJECT_APPS_KEY(projectId) }),
  });
}

export function useDeleteProjectApp(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deleteProjectApp(projectId, slug),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROJECT_APPS_KEY(projectId) }),
  });
}

export function useDeployProjectApp(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deployProjectApp(projectId, slug),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROJECT_APPS_KEY(projectId) }),
  });
}

export function useStopProjectApp(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => stopProjectApp(projectId, slug),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROJECT_APPS_KEY(projectId) }),
  });
}

export function useProjectAppLogs(projectId: string, slug: string | null) {
  return useQuery({
    queryKey: ['project-apps', projectId, 'logs', slug ?? ''],
    queryFn: () => getProjectAppLogs(projectId, slug!),
    enabled: !!slug,
    // Logs are an explicit user pull, but we refresh while the modal is open.
    refetchInterval: 6000,
  });
}
