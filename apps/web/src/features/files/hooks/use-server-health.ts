'use client';

import type { ServerHealth } from '@/features/file-browser/types';
import {
  requestRuntimeReconnect,
  useRuntimeConnectionStore,
  useRuntimeProjectInfo,
} from '@kortix/sdk/react';
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
  const status = useRuntimeConnectionStore((s) => s.status);
  const runtimeHealthy = useRuntimeConnectionStore((s) => s.healthy);
  const version = useRuntimeConnectionStore((s) => s.openCodeVersion);
  // The control plane answered the probe from the session row: the box is
  // asleep, not merely un-ready. `status` does not carry this — nothing clears
  // it when a box parks — so without reading it here the gate opens over a box
  // that cannot serve anything. See `fileServerHealthState`.
  const parked = useRuntimeConnectionStore((s) => s.parked);

  // Return a shape compatible with the old UseQueryResult<ServerHealth>
  // so consumers don't need to change their destructuring pattern.
  const data: ServerHealth | undefined = fileServerHealthState(
    status,
    runtimeHealthy,
    version,
    parked,
  );

  return {
    data,
    parked,
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
 * CONSOLIDATED: Now uses the same React Query key as useRuntimeCurrentProject
 * (runtimeKeys.currentProject()) to share cache and prevent duplicate fetches.
 * Previously used a different key ['opencode-server', 'project', serverUrl]
 * which caused independent duplicate requests.
 */
export function useCurrentProject(options?: { enabled?: boolean }) {
  return useRuntimeProjectInfo(options);
}
