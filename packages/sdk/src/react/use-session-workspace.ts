'use client';

import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ProjectSessionEnvironment } from '../core/rest/projects-client';
import { resolveSessionWorkspaceEnvironment } from '../core/session/workspace-readiness';
import {
  setCurrentWorkspaceRuntime,
  type CurrentRuntimeState,
} from '../core/session/current-runtime';
import { getSandboxUrlForExternalId } from '../core/session/server-store/url-helpers';
import { useCurrentRuntime } from './use-current-runtime';

export type SessionWorkspacePhase = 'idle' | 'resolving' | 'ready' | 'error';

export interface UseSessionWorkspaceResult {
  phase: SessionWorkspacePhase;
  runtimeUrl: string | null;
  sandboxId: string | null;
  environment: ProjectSessionEnvironment | null;
  error: unknown;
  retry: () => Promise<unknown>;
}

export const sessionWorkspaceKey = (projectId: string, sessionId: string) =>
  ['session-workspace', projectId, sessionId] as const;

export function deriveSessionWorkspacePhase(input: {
  enabled: boolean;
  dataRuntimeKind: CurrentRuntimeState['dataRuntimeKind'];
  workspaceUrl: string | null;
  environmentStatus: ProjectSessionEnvironment['status'] | null;
  hasError: boolean;
}): SessionWorkspacePhase {
  if (!input.enabled) return 'idle';
  if (!input.dataRuntimeKind) return 'resolving';
  if (input.workspaceUrl) return 'ready';
  if (input.hasError || input.environmentStatus === 'error') return 'error';
  return 'resolving';
}

/**
 * Resolve the data half of a session only when a workspace surface mounts.
 * Pi sessions provision or resume their environment. One-box sessions reuse
 * their control runtime and issue no environment request.
 */
export function useSessionWorkspace(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: { enabled?: boolean },
): UseSessionWorkspaceResult {
  const enabled = Boolean(projectId && sessionId) && options?.enabled !== false;
  const dataRuntimeKind = useCurrentRuntime((state) => state.dataRuntimeKind);
  const workspaceUrl = useCurrentRuntime((state) => state.workspaceUrl);
  const workspaceSandboxId = useCurrentRuntime((state) => state.workspaceSandboxId);
  const needsEnvironment = enabled && dataRuntimeKind === 'environment' && !workspaceUrl;

  const environmentQuery = useQuery({
    queryKey: sessionWorkspaceKey(projectId ?? '', sessionId ?? ''),
    queryFn: ({ signal }) =>
      resolveSessionWorkspaceEnvironment(projectId as string, sessionId as string, signal),
    enabled: needsEnvironment,
    refetchInterval: (query) =>
      query.state.data?.ready ? false : 1_000,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2_000),
    staleTime: 0,
  });

  const environment = environmentQuery.data?.environment ?? null;
  const environmentReady = environmentQuery.data?.ready === true;
  useEffect(() => {
    if (dataRuntimeKind !== 'environment') return;
    if (!environmentReady || !environment?.external_id) return;
    setCurrentWorkspaceRuntime(
      getSandboxUrlForExternalId(environment.external_id),
      environment.external_id,
    );
  }, [dataRuntimeKind, environment, environmentReady]);

  const phase = deriveSessionWorkspacePhase({
    enabled,
    dataRuntimeKind,
    workspaceUrl,
    environmentStatus: environment?.status ?? null,
    hasError: environmentQuery.isError,
  });
  const retry = useCallback(async () => {
    if (!needsEnvironment) return undefined;
    return environmentQuery.refetch();
  }, [environmentQuery.refetch, needsEnvironment]);

  return {
    phase,
    runtimeUrl: workspaceUrl,
    sandboxId: workspaceSandboxId,
    environment,
    error: environmentQuery.error,
    retry,
  };
}
