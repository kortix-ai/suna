'use client';

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createAppVolumeSnapshot,
  destroyAppMachine,
  destroyAppVolume,
  forkAppVolume,
  listAppMachines,
  listAppVolumeSnapshots,
  listAppVolumes,
  restartAppMachine,
  restoreAppVolume,
  scaleApp,
  startAppMachine,
  stopAppMachine,
  updateAppVolume,
  createApp,
  createAppAccessSession,
  createAppDeployment,
  deleteApp,
  getAppAccess,
  getAppDeployment,
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

export const appDeploymentKey = (
  projectId: string | null | undefined,
  appId: string | null | undefined,
  deploymentId: string | null | undefined,
) => qk.project.appDeployment(projectId ?? '', appId ?? '', deploymentId ?? '');

/** The project's App list, which also covers every channel's Apps (`qk.project.spaceApps`). */
function invalidateProjectApps(queryClient: QueryClient, projectId: string | null | undefined) {
  return queryClient.invalidateQueries({ queryKey: projectAppsKey(projectId) });
}

const SETTLED_DEPLOYMENT = new Set(['ready', 'failed', 'cancelled']);

/** Project App inventory (only the Apps the caller may open; a project manager: every App) and lifecycle mutations. */
export function useProjectApps(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectAppsKey(projectId);
  const query = useQuery({
    queryKey,
    queryFn: () => listApps(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
  });
  const invalidate = () => invalidateProjectApps(queryClient, projectId);

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
  const query = useQuery({
    queryKey,
    queryFn: () => listAppDeployments(projectId as string, appId as string),
    enabled: !!projectId && !!appId,
    ...contract('inventory'),
    refetchInterval: 5_000,
  });
  const invalidate = () => {
    void invalidateProjectApps(queryClient, projectId);
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

/**
 * One deployment and its events: lifecycle events and the build log
 * (`build_log`, `log_truncated`). Polled every 2 s while the deployment is
 * still in progress.
 */
export function useAppDeployment(
  projectId: string | null | undefined,
  appId: string | null | undefined,
  deploymentId: string | null | undefined,
) {
  return useQuery({
    queryKey: appDeploymentKey(projectId, appId, deploymentId),
    queryFn: () => getAppDeployment(projectId as string, appId as string, deploymentId as string),
    enabled: !!projectId && !!appId && !!deploymentId,
    ...contract('inventory'),
    refetchInterval: (query: { state: { data?: { deployment: { status: string } } } }) =>
      query.state.data && SETTLED_DEPLOYMENT.has(query.state.data.deployment.status) ? false : 2_000,
  });
}

export interface UseAppAccessOptions {
  /**
   * Fetch the access POLICY as well as the session. Defaults to true.
   *
   * `GET .../apps/{id}/access` reads the full policy (`project.app.read`). A
   * list of Apps only needs the SESSION
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
        invalidateProjectApps(queryClient, projectId),
      ]);
    },
  });
  return { policy, session, update };
}

export const appMachinesKey = (projectId: string | null | undefined, appId: string | null | undefined) =>
  qk.project.appMachines(projectId ?? '', appId ?? '');
export const appVolumesKey = (projectId: string | null | undefined, appId: string | null | undefined) =>
  qk.project.appVolumes(projectId ?? '', appId ?? '');

/** An App's machines, polled every 5 s, with start/stop/restart/destroy and scale. */
export function useAppMachines(projectId: string | null | undefined, appId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = appMachinesKey(projectId, appId);
  const query = useQuery({
    queryKey,
    queryFn: () => listAppMachines(projectId as string, appId as string),
    enabled: !!projectId && !!appId,
    ...contract('inventory'),
    refetchInterval: 5_000,
  });
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey }),
    invalidateProjectApps(queryClient, projectId),
  ]);
  const start = useMutation({
    mutationFn: (machineId: string) => startAppMachine(projectId as string, appId as string, machineId),
    onSuccess: invalidate,
  });
  const stop = useMutation({
    mutationFn: (machineId: string) => stopAppMachine(projectId as string, appId as string, machineId),
    onSuccess: invalidate,
  });
  const restart = useMutation({
    mutationFn: (machineId: string) => restartAppMachine(projectId as string, appId as string, machineId),
    onSuccess: invalidate,
  });
  const destroy = useMutation({
    mutationFn: (machineId: string) => destroyAppMachine(projectId as string, appId as string, machineId),
    onSuccess: invalidate,
  });
  const scale = useMutation({
    mutationFn: (count: Record<string, number>) => scaleApp(projectId as string, appId as string, count),
    onSuccess: invalidate,
  });
  return { ...query, start, stop, restart, destroy, scale };
}

/** An App's volumes, with snapshot, restore, fork, extend and destroy. */
export function useAppVolumes(projectId: string | null | undefined, appId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = appVolumesKey(projectId, appId);
  const query = useQuery({
    queryKey,
    queryFn: () => listAppVolumes(projectId as string, appId as string),
    enabled: !!projectId && !!appId,
    ...contract('inventory'),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey });
  const snapshot = useMutation({
    mutationFn: (volumeId: string) => createAppVolumeSnapshot(projectId as string, appId as string, volumeId),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: (input: { volumeId: string; snapshotId: string }) =>
      restoreAppVolume(projectId as string, appId as string, input.volumeId, input.snapshotId),
    onSuccess: invalidate,
  });
  const fork = useMutation({
    mutationFn: (input: { volumeId: string; name: string; snapshotId?: string }) =>
      forkAppVolume(projectId as string, appId as string, input.volumeId, { name: input.name, snapshot_id: input.snapshotId }),
    onSuccess: invalidate,
  });
  const extend = useMutation({
    mutationFn: (input: { volumeId: string; sizeGb: number }) =>
      updateAppVolume(projectId as string, appId as string, input.volumeId, { size_gb: input.sizeGb }),
    onSuccess: invalidate,
  });
  const destroy = useMutation({
    mutationFn: (input: { volumeId: string; name: string }) =>
      destroyAppVolume(projectId as string, appId as string, input.volumeId, input.name),
    onSuccess: invalidate,
  });
  return { ...query, snapshot, restore, fork, extend, destroy };
}

/** A volume's snapshots, newest first. */
export function useAppVolumeSnapshots(
  projectId: string | null | undefined,
  appId: string | null | undefined,
  volumeId: string | null | undefined,
) {
  return useQuery({
    queryKey: qk.project.appVolumeSnapshots(projectId ?? '', appId ?? '', volumeId ?? ''),
    queryFn: () => listAppVolumeSnapshots(projectId as string, appId as string, volumeId as string),
    enabled: !!projectId && !!appId && !!volumeId,
    ...contract('inventory'),
  });
}
