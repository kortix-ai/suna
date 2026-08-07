'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createApp,
  createAppDeployment,
  deleteApp,
  listAppDeployments,
  listApps,
  rollbackApp,
  startApp,
  stopApp,
  updateApp,
} from '../core/rest/projects-client';

export const projectAppsKey = (projectId: string | null | undefined) =>
  ['project-apps', projectId] as const;

export const appDeploymentsKey = (
  projectId: string | null | undefined,
  appId: string | null | undefined,
) => ['app-deployments', projectId, appId] as const;

/** Project App inventory and lifecycle mutations. */
export function useProjectApps(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectAppsKey(projectId);
  const query = useQuery({
    queryKey,
    queryFn: () => listApps(projectId as string),
    enabled: !!projectId,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof createApp>[1]) => createApp(projectId as string, input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (args: { appId: string; input: Parameters<typeof updateApp>[2] }) =>
      updateApp(projectId as string, args.appId, args.input),
    onSuccess: invalidate,
  });
  const start = useMutation({
    mutationFn: (appId: string) => startApp(projectId as string, appId),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: (appId: string) => stopApp(projectId as string, appId),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (appId: string) => deleteApp(projectId as string, appId),
    onSuccess: invalidate,
  });

  return { ...query, create, update, start, stop, remove };
}

/** Immutable deployment history and deployment-specific mutations. */
export function useAppDeployments(
  projectId: string | null | undefined,
  appId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const queryKey = appDeploymentsKey(projectId, appId);
  const appsKey = projectAppsKey(projectId);
  const query = useQuery({
    queryKey,
    queryFn: () => listAppDeployments(projectId as string, appId as string),
    enabled: !!projectId && !!appId,
    refetchInterval: 5_000,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: appsKey });
    void queryClient.invalidateQueries({ queryKey });
  };

  const deploy = useMutation({
    mutationFn: (input: Parameters<typeof createAppDeployment>[2]) =>
      createAppDeployment(projectId as string, appId as string, input),
    onSuccess: invalidate,
  });
  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      rollbackApp(projectId as string, appId as string, deploymentId),
    onSuccess: invalidate,
  });

  return { ...query, deploy, rollback };
}
