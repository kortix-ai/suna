'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createApp,
  createAppAccessSession,
  createAppDeployment,
  deleteApp,
  getAppAccess,
  listAppDeployments,
  listApps,
  rollbackApp,
  startApp,
  stopApp,
  updateApp,
  updateAppAccess,
} from '../core/rest/workspaces-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

export const workspaceAppsKey = (workspaceId: string | null | undefined) =>
  qk.workspace.apps(workspaceId ?? '');

/** @deprecated Use `workspaceAppsKey`. */
export const projectAppsKey = workspaceAppsKey;

export const appDeploymentsKey = (
  workspaceId: string | null | undefined,
  appId: string | null | undefined,
) => qk.workspace.appDeployments(workspaceId ?? '', appId ?? '');

/** Workspace App inventory and lifecycle mutations. */
export function useWorkspaceApps(workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = workspaceAppsKey(workspaceId);
  const query = useQuery({
    queryKey,
    queryFn: () => listApps(workspaceId as string),
    enabled: !!workspaceId,
    ...contract('inventory'),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof createApp>[1]) => createApp(workspaceId as string, input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (args: { appId: string; input: Parameters<typeof updateApp>[2] }) =>
      updateApp(workspaceId as string, args.appId, args.input),
    onSuccess: invalidate,
  });
  const start = useMutation({
    mutationFn: (appId: string) => startApp(workspaceId as string, appId),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: (appId: string) => stopApp(workspaceId as string, appId),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (appId: string) => deleteApp(workspaceId as string, appId),
    onSuccess: invalidate,
  });

  return { ...query, create, update, start, stop, remove };
}

/** @deprecated Use `useWorkspaceApps`. */
export const useProjectApps = useWorkspaceApps;

/** Immutable deployment history and deployment-specific mutations. */
export function useAppDeployments(
  workspaceId: string | null | undefined,
  appId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const queryKey = appDeploymentsKey(workspaceId, appId);
  const appsKey = workspaceAppsKey(workspaceId);
  const query = useQuery({
    queryKey,
    queryFn: () => listAppDeployments(workspaceId as string, appId as string),
    enabled: !!workspaceId && !!appId,
    ...contract('inventory'),
    refetchInterval: 5_000,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: appsKey });
    void queryClient.invalidateQueries({ queryKey });
  };

  const deploy = useMutation({
    mutationFn: (input: Parameters<typeof createAppDeployment>[2]) =>
      createAppDeployment(workspaceId as string, appId as string, input),
    onSuccess: invalidate,
  });
  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      rollbackApp(workspaceId as string, appId as string, deploymentId),
    onSuccess: invalidate,
  });

  return { ...query, deploy, rollback };
}

/** App access policy plus a short-lived URL that exchanges into a host-only cookie. */
export function useAppAccess(
  workspaceId: string | null | undefined,
  appId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const queryKey = qk.workspace.appAccess(workspaceId ?? '', appId ?? '');
  const sessionQueryKey = qk.workspace.appAccessSession(workspaceId ?? '', appId ?? '');
  const policy = useQuery({
    queryKey,
    queryFn: () => getAppAccess(workspaceId as string, appId as string),
    enabled: !!workspaceId && !!appId,
    ...contract('config'),
  });
  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: () => createAppAccessSession(workspaceId as string, appId as string),
    enabled: !!workspaceId && !!appId,
    staleTime: 4 * 60_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof updateAppAccess>[2]) =>
      updateAppAccess(workspaceId as string, appId as string, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
        queryClient.invalidateQueries({ queryKey: qk.workspace.apps(workspaceId ?? '') }),
      ]);
    },
  });
  return { policy, session, update };
}
