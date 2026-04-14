/**
 * useSandboxUpdate — checks for sandbox updates and lets the user trigger them.
 *
 * Supports both stable and dev channels:
 *   - If running a dev build (version starts with "dev-"), compares against latest dev
 *   - If running a stable build, compares against latest stable
 *
 * Docker image-based update flow:
 *   - `currentVersion` is provided by the caller (from /kortix/health)
 *   - `latestVersion` is fetched from the platform API (channel-aware)
 *   - Frontend compares them → `updateAvailable`
 *   - `update()` POSTs to kortix-api which pulls new image + recreates container
 *   - Polls GET /platform/sandbox/update/status every 2s → live phase + progress
 *   - On complete/failed, stops polling and surfaces result
 */

'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  getLatestSandboxVersion,
  triggerSandboxUpdate,
  getSandboxUpdateStatus,
  resetSandboxUpdateStatus,
  isDestructivePhase,
  type SandboxUpdateStatus,
  type UpdatePhase,
  type VersionChannel,
} from '@/lib/platform-client';
import { setSandboxVersion } from '@/stores/sandbox-connection-store';
import { useServerStore } from '@/stores/server-store';
import { type SandboxInfo } from '@/lib/platform-client';

export type { UpdatePhase, SandboxUpdateStatus };

// Human-readable label for each phase (Docker-based flow)
export const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle:         'Idle',
  backing_up:   'Creating backup...',
  pulling:      'Downloading update...',
  patching:     'Preparing update...',
  stopping:     'Stopping sandbox...',
  removing:     'Preparing update...',
  recreating:   'Installing update...',
  restarting:   'Restarting sandbox...',
  verifying:    'Verifying update...',
  starting:     'Starting sandbox...',
  health_check: 'Running health checks...',
  complete:     'Update complete',
  failed:       'Update failed',
};

export const PHASE_PROGRESS: Record<UpdatePhase, number> = {
  idle:         0,
  backing_up:   5,
  pulling:      15,
  patching:     35,
  stopping:     50,
  removing:     55,
  recreating:   65,
  restarting:   60,
  verifying:    80,
  starting:     75,
  health_check: 90,
  complete:     100,
  failed:       100,
};

/**
 * Detect the channel from a version string.
 * dev-{sha8} → 'dev', anything else → 'stable'
 */
export function detectChannel(version: string | null): VersionChannel {
  if (!version) return 'stable';
  return version.startsWith('dev-') ? 'dev' : 'stable';
}

/**
 * Compare two semver-like version strings (e.g. "0.4.11" vs "0.4.12").
 * Returns true when `latest` is strictly greater than `current`.
 */
function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

/**
 * Compare dev versions: dev-{sha8} strings are different if they differ.
 * We can't do semantic ordering, so any difference = update available.
 */
function isNewerDevVersion(current: string, latest: string): boolean {
  if (!current || !latest) return false;
  // Different dev versions → update available
  return current !== latest;
}

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_PHASES: UpdatePhase[] = ['complete', 'failed'];

export function useSandboxUpdate(currentVersion: string | null) {
  const activeServer = useServerStore((s) => {
    const entry = s.servers.find((srv) => srv.id === s.activeServerId);
    return entry ?? null;
  });

  // Memoize so effect deps are stable (new object every render otherwise would
  // reset interval timers that watch this value).
  const sandbox: SandboxInfo | null = useMemo(() => {
    if (!activeServer?.instanceId) return null;
    return {
      sandbox_id: activeServer.instanceId,
      external_id: activeServer.sandboxId ?? '',
      name: activeServer.label,
      provider: (activeServer.provider ?? 'local_docker') as SandboxInfo['provider'],
      base_url: activeServer.url,
      status: 'active',
      created_at: '',
      updated_at: '',
    };
  }, [activeServer?.instanceId, activeServer?.sandboxId, activeServer?.label, activeServer?.provider, activeServer?.url]);

  // Detect which channel the running instance belongs to
  const currentChannel = useMemo(() => detectChannel(currentVersion), [currentVersion]);

  // ── Latest version from platform (channel-aware) ────────────────────────
  const latestQuery = useQuery({
    queryKey: ['sandbox', 'latest-version', currentChannel],
    queryFn: () => getLatestSandboxVersion(currentChannel),
    enabled: !!sandbox,
    staleTime: 5 * 60 * 1000,        // re-fetch from GitHub at most every 5 min
    refetchInterval: 10 * 60 * 1000, // background poll every 10 min
    refetchOnWindowFocus: true,       // re-check when user returns to the tab
  });

  const latestVersion = latestQuery.data?.version ?? null;
  const latestChannel = (latestQuery.data?.channel as VersionChannel) ?? currentChannel;

  const updateAvailable = useMemo(() => {
    if (!currentVersion || !latestVersion) return false;
    if (currentChannel === 'dev') {
      return isNewerDevVersion(currentVersion, latestVersion);
    }
    return isNewerVersion(currentVersion, latestVersion);
  }, [currentVersion, latestVersion, currentChannel]);

  // ── Live update status (polled while in-progress) ────────────────────────
  const [liveStatus, setLiveStatus] = useState<SandboxUpdateStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; currentVersion: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollActiveRef = useRef(false);

  const stopPolling = useCallback(() => {
    pollActiveRef.current = false;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const pollStatus = useCallback(async () => {
    if (!pollActiveRef.current) return;
    try {
      // Poll kortix-api for update status (not the sandbox directly)
      const status = await getSandboxUpdateStatus(sandbox ?? undefined);
      setLiveStatus(status);

      if (TERMINAL_PHASES.includes(status.phase)) {
        stopPolling();
        if (status.phase === 'complete') {
          const newVersion = status.currentVersion || latestVersion || '0.0.0';
          setUpdateResult({ success: true, currentVersion: newVersion });
          setSandboxVersion(newVersion);
        } else if (status.phase === 'failed') {
          setUpdateResult({ success: false, currentVersion: status.currentVersion || currentVersion || '0.0.0' });
        }
        return;
      }
    } catch {
      // API may be momentarily unreachable during container recreate — keep polling
    }

    if (pollActiveRef.current) {
      pollRef.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
    }
  }, [stopPolling, latestVersion, currentVersion, sandbox]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollActiveRef.current = true;
    setIsPolling(true);
    setUpdateResult(null);
    pollRef.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
  }, [pollStatus, stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pollActiveRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // Each `useSandboxUpdate` instance owns its own state (sidebar + dialog
  // provider each mount one). When the user triggers an update from one
  // instance, the other won't know unless it polls independently. A slow
  // background check (every 4s) catches in-progress updates; refresh/logout
  // and second-tab handoff all rely on this.
  useEffect(() => {
    if (!sandbox) return;
    let cancelled = false;
    const check = async () => {
      try {
        const status = await getSandboxUpdateStatus(sandbox);
        if (cancelled) return;
        if (!TERMINAL_PHASES.includes(status.phase) && status.phase !== 'idle' && !pollActiveRef.current) {
          setLiveStatus(status);
          startPolling();
        }
      } catch {
        // Non-fatal — retry next tick.
      }
    };
    check();
    const iv = setInterval(check, 4_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [sandbox, startPolling]);

  // ── Trigger mutation ─────────────────────────────────────────────────────
  const updateMutation = useMutation({
    mutationFn: async (targetVersion?: string) => {
      const versionToInstall = targetVersion || latestVersion;
      if (!sandbox || !versionToInstall) throw new Error('No sandbox or version');
      // Start polling immediately — the POST returns immediately (fire-and-forget)
      startPolling();
      return triggerSandboxUpdate(sandbox, versionToInstall);
    },
    onSuccess: (data) => {
      // The POST returns { started: true } immediately — actual progress comes from polling.
      // If data.started is true, keep polling. If it returned an error, stop.
      if (!(data as { started?: boolean })?.started && (data as { success?: boolean })?.success === false) {
        stopPolling();
        setUpdateResult({ success: false, currentVersion: currentVersion ?? '0.0.0' });
      }
    },
    onError: (error) => {
      stopPolling();
      setUpdateResult({ success: false, currentVersion: currentVersion ?? '0.0.0' });
      setLiveStatus(prev => prev ? {
        ...prev, phase: 'failed',
        message: 'Update failed',
        error: error instanceof Error ? error.message : 'Failed to start update',
      } : null);
    },
  });

  const isUpdating = updateMutation.isPending || isPolling;
  const phase: UpdatePhase = liveStatus?.phase ?? 'idle';
  const isDestructive = isDestructivePhase(phase);
  const isBackingUp = phase === 'backing_up';
  const phaseLabel = PHASE_LABELS[phase];
  // Use the real progress from the API if available, otherwise use phase-based progress
  const phaseProgress = liveStatus?.progress ?? PHASE_PROGRESS[phase];
  const phaseMessage = liveStatus?.message ?? '';
  const updateErrorMessage = liveStatus?.error ?? (updateMutation.error instanceof Error ? updateMutation.error.message : null);
  const update = useCallback((targetVersion?: string) => {
    updateMutation.mutate(targetVersion);
  }, [updateMutation]);

  return {
    /** Whether a newer version is available */
    updateAvailable,
    /** Current version running on the sandbox */
    currentVersion,
    /** Latest version available (in the same channel) */
    latestVersion,
    /** Channel of the currently running version */
    currentChannel,
    /** Channel of the latest available version */
    latestChannel,
    /** Changelog for the latest available version */
    changelog: latestQuery.data?.changelog ?? null,
    /** Trigger the update */
    update,
    /** Whether an update is currently running */
    isUpdating,
    /** True for phases that require a blocking dialog (pull/stop/restart/etc) */
    isDestructive,
    /** True while the pre-update backup is running (non-blocking) */
    isBackingUp,
    /** Live update phase from API */
    phase,
    /** Human-readable phase label */
    phaseLabel,
    /** Phase progress 0-100 */
    phaseProgress,
    /** Detailed message from the API for the current phase */
    phaseMessage,
    /** Detailed error from the API or mutation layer */
    updateErrorMessage,
    /** Result of the last update attempt */
    updateResult,
    /** Error from the last update attempt */
    updateError: updateMutation.error,
    /** Whether we're still loading version info */
    isLoading: latestQuery.isLoading,
    /** Re-check latest version */
    refetch: () => latestQuery.refetch(),
    /** Reset update status (e.g. after a failed update to allow retry) */
    resetStatus: () => resetSandboxUpdateStatus(sandbox ?? undefined),
  };
}
