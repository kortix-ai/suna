import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useCallback, useState } from 'react';
import { backendApi } from '@/lib/api-client';
import { sandboxKeys } from './keys';
import type {
  SandboxStatus,
  SandboxState,
  ServicesHealth,
} from '@agentpress/shared/types/sandbox';

// Re-export types for convenience
export type { SandboxStatus, SandboxState, ServicesHealth } from '@agentpress/shared/types/sandbox';
export {
  deriveSandboxStatus,
  isSandboxUsable,
  isSandboxTransitioning,
  isSandboxOffline,
  isSandboxFailed,
  getSandboxStatusLabel,
} from '@agentpress/shared/types/sandbox';

// ============================================================================
// Legacy SandboxDetails (kept for backwards compatibility)
// ============================================================================

export interface SandboxDetails {
  sandbox_id: string;
  state: string;
  project_id: string;
  vnc_preview?: string;
  sandbox_url?: string;
  created_at?: string;
  updated_at?: string;
  target?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  labels?: Record<string, string>;
}

interface SandboxDetailsResponse {
  status: string;
  sandbox: SandboxDetails;
}

/**
 * Legacy hook - fetches raw sandbox details from Daytona
 * @deprecated Use useSandboxStatus for unified status with health checks
 */
export function useSandboxDetails(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<SandboxDetails | null>({
    queryKey: sandboxKeys.details(projectId || ''),
    queryFn: async () => {
      if (!projectId) return null;

      const response = await backendApi.get<SandboxDetailsResponse>(
        `/project/${projectId}/sandbox`,
        { showErrors: false }
      );

      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to fetch sandbox details');
      }

      return response.data.sandbox;
    },
    enabled: !!projectId && (options?.enabled !== false),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

// ============================================================================
// New Unified Sandbox Status API
// ============================================================================

/**
 * Hook to fetch unified sandbox status (combines Daytona state + service health)
 *
 * Returns:
 * - status: LIVE | STARTING | OFFLINE | FAILED | UNKNOWN
 * - daytonaState: Raw state from Daytona (started/stopped/archived)
 * - servicesHealth: Health info from sandbox container (when available)
 *
 * Features:
 * - Adaptive polling: 3s when STARTING, 30s otherwise
 * - Combines Daytona state with in-container health checks
 */
export function useSandboxStatus(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<SandboxState | null>({
    queryKey: sandboxKeys.status(projectId || ''),
    queryFn: async () => {
      if (!projectId) return null;

      const response = await backendApi.get<SandboxState>(
        `/project/${projectId}/sandbox/status`,
        { showErrors: false }
      );

      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to fetch sandbox status');
      }

      return response.data;
    },
    enabled: !!projectId && (options?.enabled !== false),
    // Adaptive stale time - faster refresh when starting/unknown
    staleTime: (query) => {
      const status = query.state.data?.status;
      // Very short stale time when transitioning or unknown
      if (status === 'STARTING' || status === 'UNKNOWN') return 1000;
      return 10 * 1000;
    },
    // Adaptive polling - faster when transitioning or unknown (sandbox might be starting)
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Poll faster when sandbox is starting up or unknown
      if (status === 'STARTING') return 2000;
      if (status === 'UNKNOWN') return 5000; // Sandbox might be being created
      if (status === 'OFFLINE') return 10000; // User might start it
      return 30000;
    },
    refetchOnWindowFocus: true, // Refetch when user comes back to tab
    refetchOnMount: 'always', // Always fetch on mount to show current status immediately
  });
}

/**
 * Mutation hook to start (or create) a sandbox
 */
export function useStartSandbox() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (projectId: string) => {
      const response = await backendApi.post<{ status: string; sandbox_id: string | null; message: string }>(
        `/project/${projectId}/sandbox/start`
      );

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to start sandbox');
      }

      return response.data;
    },
    onSuccess: (_, projectId) => {
      // Invalidate status query to trigger refetch with faster polling
      queryClient.invalidateQueries({ queryKey: sandboxKeys.status(projectId) });
    },
  });
}

/**
 * Mutation hook to stop a sandbox
 */
export function useStopSandbox() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (projectId: string) => {
      const response = await backendApi.post<{ status: string; sandbox_id: string; message: string }>(
        `/project/${projectId}/sandbox/stop`
      );

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to stop sandbox');
      }

      return response.data;
    },
    onSuccess: (_, projectId) => {
      // Invalidate status query to trigger refetch
      queryClient.invalidateQueries({ queryKey: sandboxKeys.status(projectId) });
    },
  });
}

// ============================================================================
// Auto-Start Hook - Combines status checking with automatic restart
// ============================================================================

// Global map to track auto-start attempts per project
// This prevents multiple hook instances from triggering simultaneous starts
const globalAutoStartAttempted = new Map<string, boolean>();
const globalAutoStartInProgress = new Map<string, boolean>();

/**
 * Hook that monitors sandbox status and auto-starts if OFFLINE.
 *
 * Features:
 * - Auto-starts sandbox when OFFLINE is detected (with sandbox_id present)
 * - Doesn't auto-start for UNKNOWN (no sandbox exists yet - need to create via agent)
 * - Tracks "isAutoStarting" state for UI feedback
 * - Prevents multiple auto-start attempts (globally across all hook instances)
 * - Returns effective status (STARTING during auto-start attempt)
 *
 * @param projectId - Project ID to monitor
 * @param options.enabled - Whether to enable the hook (default: true)
 * @param options.autoStart - Whether to auto-start OFFLINE sandboxes (default: true)
 */
export function useSandboxStatusWithAutoStart(
  projectId: string | undefined,
  options?: {
    enabled?: boolean;
    autoStart?: boolean;
  }
) {
  const autoStartEnabled = options?.autoStart !== false;
  const [isAutoStarting, setIsAutoStarting] = useState(false);
  const lastProjectIdRef = useRef<string | undefined>(undefined);

  // Reset auto-start state when project changes
  useEffect(() => {
    if (lastProjectIdRef.current !== projectId && projectId) {
      // Clear global state for the new project
      globalAutoStartAttempted.delete(projectId);
      globalAutoStartInProgress.delete(projectId);
      setIsAutoStarting(false);
      lastProjectIdRef.current = projectId;
    }
  }, [projectId]);

  // Sync local state with global state
  useEffect(() => {
    if (projectId) {
      const inProgress = globalAutoStartInProgress.get(projectId) || false;
      setIsAutoStarting(inProgress);
    }
  }, [projectId]);

  // Get sandbox status
  const statusQuery = useSandboxStatus(projectId, { enabled: options?.enabled });
  const { data: sandboxState } = statusQuery;

  // Start sandbox mutation
  const startSandbox = useStartSandbox();

  // Use ref to avoid stale closures with mutation
  const startSandboxRef = useRef(startSandbox);
  startSandboxRef.current = startSandbox;

  // Auto-start logic
  const attemptAutoStart = useCallback(async () => {
    if (!projectId) return;

    const alreadyAttempted = globalAutoStartAttempted.get(projectId);
    const alreadyInProgress = globalAutoStartInProgress.get(projectId);

    if (!autoStartEnabled) return;
    if (alreadyAttempted || alreadyInProgress) return;
    if (!sandboxState) return;

    // Only auto-start if:
    // 1. Status is OFFLINE (sandbox exists but stopped)
    // 2. We have a sandbox_id (confirms sandbox exists)
    // 3. Not already starting
    const shouldAutoStart =
      sandboxState.status === 'OFFLINE' &&
      sandboxState.sandbox_id &&
      sandboxState.sandbox_id.length > 0 &&
      !startSandboxRef.current.isPending;

    if (shouldAutoStart) {
      // CRITICAL: Set global flags SYNCHRONOUSLY before any async work
      // This prevents multiple hook instances from triggering simultaneous starts
      globalAutoStartAttempted.set(projectId, true);
      globalAutoStartInProgress.set(projectId, true);
      setIsAutoStarting(true);

      try {
        await startSandboxRef.current.mutateAsync(projectId);
      } catch (error) {
        console.error('[useSandboxStatusWithAutoStart] Auto-start failed:', error);
        // Reset so user can try again
        globalAutoStartAttempted.set(projectId, false);
        globalAutoStartInProgress.set(projectId, false);
        setIsAutoStarting(false);
      }
    }
  }, [projectId, autoStartEnabled, sandboxState]);

  // Trigger auto-start when status becomes OFFLINE
  useEffect(() => {
    if (sandboxState?.status === 'OFFLINE') {
      attemptAutoStart();
    }
    // Clear isAutoStarting when status changes away from OFFLINE (sandbox is now running)
    if (projectId && sandboxState?.status && sandboxState.status !== 'OFFLINE') {
      globalAutoStartInProgress.set(projectId, false);
      setIsAutoStarting(false);
    }
  }, [sandboxState?.status, attemptAutoStart, projectId]);

  // Compute effective status - show STARTING if we're auto-starting
  const effectiveStatus: SandboxStatus | undefined =
    isAutoStarting && sandboxState?.status === 'OFFLINE'
      ? 'STARTING'
      : sandboxState?.status;

  return {
    ...statusQuery,
    // Override data to include effective status
    data: sandboxState ? {
      ...sandboxState,
      status: effectiveStatus || sandboxState.status,
    } : null,
    // Expose original status for debugging
    originalStatus: sandboxState?.status,
    // Whether we're in the process of auto-starting
    isAutoStarting,
    // Whether auto-start is enabled
    autoStartEnabled,
    // Reset auto-start attempt (e.g., for manual retry)
    resetAutoStart: useCallback(() => {
      if (projectId) {
        globalAutoStartAttempted.set(projectId, false);
        globalAutoStartInProgress.set(projectId, false);
      }
      setIsAutoStarting(false);
    }, [projectId]),
  };
}
