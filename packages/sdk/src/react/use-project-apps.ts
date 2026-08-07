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
import { contract } from './query-contracts';
import { qk } from './query-keys';

export const projectAppsKey = (projectId: string | null | undefined) =>
  qk.project.apps(projectId ?? '');

export const appDeploymentsKey = (
  projectId: string | null | undefined,
  appId: string | null | undefined,
) => qk.project.appDeployments(projectId ?? '', appId ?? '');

/** Project App inventory and lifecycle mutations. */
export function useProjectApps(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectAppsKey(projectId);
  const query = useQuery({
    queryKey,
    queryFn: () => listApps(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
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
    ...contract('inventory'),
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
