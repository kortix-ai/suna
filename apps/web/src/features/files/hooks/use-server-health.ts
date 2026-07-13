'use client';

import { requestRuntimeReconnect, useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import type { ServerHealth, RuntimeProjectInfo } from '@/features/file-browser/types';
import { fileServerHealthState } from './server-health-state';
import { useRuntimeCurrentProject } from '@kortix/sdk/react';

/**
 * Check if the active Runtime server is reachable and healthy.
 *
 * CONSOLIDATED: This now reads from the sandbox-connection-store (Zustand)
 * which is populated by the single health-check polling loop in
 * useSandboxConnection. Previously this ran its own independent React Query
 * polling loop — duplicating /kortix/health requests every 30s.
 *
 * Returns a React Query-compatible shape for backward compatibility,
 * but the data comes from the Zustand store, not a separate HTTP call.
 */
export function useServerHealth(options?: { enabled?: boolean }) {
  const status = useSandboxConnectionStore((s) => s.status);
  const runtimeHealthy = useSandboxConnectionStore((s) => s.healthy);
  const version = useSandboxConnectionStore((s) => s.runtimeVersion);

  // Return a shape compatible with the old UseQueryResult<ServerHealth>
  // so consumers don't need to change their destructuring pattern.
  const data: ServerHealth | undefined = fileServerHealthState(status, runtimeHealthy, version);

  return {
    data,
    isLoading: status === 'connecting' && runtimeHealthy === null,
    isError: status === 'unreachable',
    error: status === 'unreachable' ? new Error('Server unreachable') : null,
    refetch: async () => {
      requestRuntimeReconnect();
      return { data } as any;
    },
  };
}

/**
 * Get current project info from the active Runtime server.
 *
 * CONSOLIDATED: Now uses the same React Query key as useRuntimeCurrentProject
 * (runtimeKeys.currentProject()) to share cache and prevent duplicate fetches.
 * Previously used a different key ['opencode-server', 'project', serverUrl]
 * which caused independent duplicate requests.
 */
export function useCurrentProject(options?: { enabled?: boolean }) {
  const runtimeReady = useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);
  const projectQuery = useRuntimeCurrentProject();
  const projectId = projectQuery.data?.id;
  const enabled = runtimeReady && options?.enabled !== false;
  const now = Date.now();
  const data: RuntimeProjectInfo | undefined = enabled ? {
    id: projectId ?? 'workspace',
    worktree: '/workspace',
    vcs: 'git',
    name: 'workspace',
    time: { created: now, updated: now },
    sandboxes: [],
  } : undefined;

  return {
    data,
    isLoading: enabled && projectQuery.isLoading,
    isError: projectQuery.isError,
    error: projectQuery.error,
    refetch: async () => {
      await projectQuery.refetch();
      return { data } as any;
    },
  };
}
