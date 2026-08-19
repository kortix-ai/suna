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

export interface UseAppAccessOptions {
  /**
   * Fetch the access POLICY as well as the session. Defaults to true.
   *
   * `GET .../apps/{id}/access` is an administrative read — a caller without
   * `project.customize.write` gets a 403. A list of Apps only needs the SESSION
   * (the short-lived URL its preview tile loads), so a grid of N Apps was firing
   * N policy reads it never displayed, every one of them a 403 for an ordinary
   * member. Pass `false` there and let the surface that actually edits access
   * (the access modal) be the one that asks for it.
   */
  policy?: boolean;
  /**
   * Mint the access SESSION. Defaults to true.
   *
   * Same failure as `policy`, one endpoint over: `POST .../access-session` is
   * 403 for any App the caller may see but not open, and a card that renders a
   * live thumbnail asks for one on mount. A grid of N such Apps produced N
   * console errors and a broken tile, for a state that is not an error — the
   * App is simply not yours to open. Pass `App.viewer_can_access` here.
   */
  session?: boolean;
}

/** App access policy plus a short-lived URL that exchanges into a host-only cookie. */
export function useAppAccess(
  projectId: string | null | undefined,
  appId: string | null | undefined,
  options: UseAppAccessOptions = {},
) {
  const queryClient = useQueryClient();
  const wantsPolicy = options.policy ?? true;
  const wantsSession = options.session ?? true;
  const queryKey = qk.project.appAccess(projectId ?? '', appId ?? '');
  const sessionQueryKey = qk.project.appAccessSession(projectId ?? '', appId ?? '');
  const policy = useQuery({
    queryKey,
    queryFn: () => getAppAccess(projectId as string, appId as string),
    enabled: !!projectId && !!appId && wantsPolicy,
    ...contract('config'),
  });
  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: () => createAppAccessSession(projectId as string, appId as string),
    enabled: !!projectId && !!appId && wantsSession,
    staleTime: 4 * 60_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof updateAppAccess>[2]) =>
      updateAppAccess(projectId as string, appId as string, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
        queryClient.invalidateQueries({ queryKey: qk.project.apps(projectId ?? '') }),
      ]);
    },
  });
  return { policy, session, update };
}
