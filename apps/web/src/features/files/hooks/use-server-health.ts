'use client';

import { useQuery } from '@tanstack/react-query';
import { getRuntimeClient as getClient } from '@kortix/sdk/runtime-client';
import { requestRuntimeReconnect, useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import { opencodeKeys } from '@/hooks/opencode/use-opencode-sessions';
import type { ServerHealth, OpenCodeProjectInfo } from '@/features/file-browser/types';
import { fileServerHealthState } from './server-health-state';

/**
 * Check if the active OpenCode server is reachable and healthy.
 *
 * CONSOLIDATED: This now reads from the sandbox-connection-store (Zustand)
 * which is populated by the single health-check polling loop in
 * useSandboxConnection. Previously this ran its own independent React Query
 * polling loop — duplicating /global/health requests every 30s.
 *
 * Returns a React Query-compatible shape for backward compatibility,
 * but the data comes from the Zustand store, not a separate HTTP call.
 */
export function useServerHealth(options?: { enabled?: boolean }) {
  const status = useSandboxConnectionStore((s) => s.status);
  const runtimeHealthy = useSandboxConnectionStore((s) => s.healthy);
  const version = useSandboxConnectionStore((s) => s.openCodeVersion);

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
 * Get current project info from the active OpenCode server.
 *
 * CONSOLIDATED: Now uses the same React Query key as useOpenCodeCurrentProject
 * (opencodeKeys.currentProject()) to share cache and prevent duplicate fetches.
 * Previously used a different key ['opencode-server', 'project', serverUrl]
 * which caused independent duplicate requests.
 */
export function useCurrentProject(options?: { enabled?: boolean }) {
  const runtimeReady = useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);

  return useQuery<OpenCodeProjectInfo>({
    queryKey: opencodeKeys.currentProject(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.project.current();
      if (result.error) {
        const err = result.error as any;
        throw new Error(err?.data?.message || err?.message || 'SDK request failed');
      }
      return result.data as OpenCodeProjectInfo;
    },
    enabled: runtimeReady && options?.enabled !== false,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
