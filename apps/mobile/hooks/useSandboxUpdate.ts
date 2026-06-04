import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getLatestSandboxVersion,
  triggerSandboxUpdate,
  getSandboxUpdateStatus,
  resetSandboxUpdateStatus,
  type SandboxVersionInfo,
  type SandboxUpdateStatus,
  type UpdatePhase,
} from '@/lib/platform/client';
import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';

function isNewerVersion(current: string, latest: string): boolean {
  const c = current.replace(/^v/, '').split('.').map(Number);
  const l = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

const PHASE_LABELS: Record<string, string> = {
  idle: 'Idle',
  pulling: 'Downloading update...',
  stopping: 'Stopping sandbox...',
  removing: 'Preparing update...',
  recreating: 'Installing update...',
  starting: 'Starting sandbox...',
  health_check: 'Running health checks...',
  complete: 'Update complete',
  failed: 'Update failed',
};

const PHASE_PROGRESS: Record<string, number> = {
  idle: 0,
  pulling: 25,
  stopping: 50,
  removing: 55,
  recreating: 65,
  starting: 75,
  health_check: 90,
  complete: 100,
  failed: 100,
};

const POLL_INTERVAL_MS = 2000;
const TERMINAL_PHASES: UpdatePhase[] = ['complete', 'failed', 'idle'];

export function useSandboxUpdate(
  currentVersion: string | null | undefined,
  onVersionChanged?: (newVersion: string) => void,
) {
  const queryClient = useQueryClient();
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [updateStatus, setUpdateStatus] = useState<SandboxUpdateStatus | null>(null);

  // Fetch latest version
  const { data: versionInfo, isLoading, refetch } = useQuery({
    queryKey: ['sandbox', 'latest-version'],
    queryFn: getLatestSandboxVersion,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    enabled: !!currentVersion,
  });

  const latestVersion = versionInfo?.version ?? null;
  const changelog = versionInfo?.changelog ?? null;
  const updateAvailable = !!(currentVersion && latestVersion && isNewerVersion(currentVersion, latestVersion));

  // Polling for update status
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      try {
        const status = await getSandboxUpdateStatus();
        setUpdateStatus(status);
        if (TERMINAL_PHASES.includes(status.phase)) {
          stopPolling();
          // On successful update, invalidate all version-related queries
          if (status.phase === 'complete') {
            queryClient.invalidateQueries({ queryKey: ['sandbox', 'latest-version'] });
            queryClient.invalidateQueries({ queryKey: ['sandbox', 'versions'] });
            queryClient.invalidateQueries({ queryKey: ['sandbox', 'changelog'] });
            // Notify parent to re-fetch current version
            const newVer = status.currentVersion || latestVersion;
            if (newVer && onVersionChanged) {
              onVersionChanged(newVer);
            }
          }
        }
      } catch {
        // ignore polling errors
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, queryClient, latestVersion, onVersionChanged]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: (version: string) => triggerSandboxUpdate(version),
    onMutate: () => {
      setUpdateStatus({ phase: 'pulling', progress: 0, message: 'Starting update...', targetVersion: latestVersion, previousVersion: currentVersion ?? null, currentVersion: null, error: null, startedAt: new Date().toISOString(), updatedAt: null });
      startPolling();
    },
    onError: (err: any) => {
      stopPolling();
      setUpdateStatus((prev) => prev ? { ...prev, phase: 'failed', error: err?.message || 'Update failed' } : null);
    },
  });

  const update = useCallback(() => {
    if (!latestVersion) return;
    updateMutation.mutate(latestVersion);
  }, [latestVersion, updateMutation]);

  const resetStatus = useCallback(async () => {
    try {
      await resetSandboxUpdateStatus();
    } catch {}
    setUpdateStatus(null);
  }, []);

  const phase = updateStatus?.phase ?? 'idle';
  const isUpdating = updateMutation.isPending || (!!updateStatus && !TERMINAL_PHASES.includes(phase));

  return {
    updateAvailable,
    currentVersion: currentVersion ?? null,
    latestVersion,
    changelog,
    update,
    isUpdating,
    phase,
    phaseLabel: PHASE_LABELS[phase] || phase,
    phaseProgress: updateStatus?.progress ?? PHASE_PROGRESS[phase] ?? 0,
    phaseMessage: updateStatus?.message ?? '',
    updateResult: phase === 'complete' ? { success: true, currentVersion: updateStatus?.currentVersion ?? latestVersion ?? '' } : null,
    updateError: phase === 'failed' ? new Error(updateStatus?.error || 'Update failed') : null,
    isLoading,
    refetch,
    resetStatus,
  };
}

/**
 * Convenience hook that reads the current sandbox version from context.
 */
export function useGlobalSandboxUpdate() {
  const { sandboxId, sandboxUrl } = useSandboxContext();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [fetchSeq, setFetchSeq] = useState(0);

  // Fetch current version from health endpoint
  useEffect(() => {
    if (!sandboxUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAuthToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`${sandboxUrl}/kortix/health`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        // Only accept a concrete version; ignore "unknown" or empty so
        // consumers can cleanly fall back to a DB-cached value instead of
        // rendering "vunknown".
        if (!cancelled && data?.version && data.version !== 'unknown') {
          setCurrentVersion(data.version);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [sandboxUrl, fetchSeq]);

  // Callback: re-fetch health to pick up the new version after update
  const handleVersionChanged = useCallback((newVersion: string) => {
    // Only accept a concrete new version; ignore "unknown" or empty values
    if (newVersion && newVersion !== 'unknown') {
      setCurrentVersion(newVersion);
    }
    // Always re-fetch from health to get the authoritative version
    setFetchSeq((s) => s + 1);
  }, []);

  // Imperative refresh — callers can use this after update completion to force
  // a fresh health-endpoint read (useful because the sandbox restarts during
  // update and polling may land on a stale response).
  const refreshCurrentVersion = useCallback(() => {
    setFetchSeq((s) => s + 1);
  }, []);

  const update = useSandboxUpdate(currentVersion, handleVersionChanged);
  return { ...update, refreshCurrentVersion };
}
