'use client';

/**
 * InstanceUpdateDialog — self-contained "check / install update" flow for
 * a specific sandbox, rendered from the instance card on the /instances page.
 *
 * Deliberately does NOT go through `useSandboxUpdate` / the global update
 * dialog provider — both of those read the *currently active* server from
 * the store, which is the wrong sandbox when the user clicks "Changelog"
 * on any card besides the one they're already connected to. Instead this
 * hook drives `triggerSandboxUpdate(sandbox, ...)` directly, so a dead or
 * stopped machine can still be updated straight from the list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast as sonnerToast } from 'sonner';

import { UpdateDialog } from '@/components/update-dialog';
import {
  getLatestSandboxVersion,
  getSandboxUpdateStatus,
  triggerSandboxUpdate,
  type SandboxInfo,
  type SandboxUpdateStatus,
  type UpdatePhase,
  type VersionChannel,
} from '@/lib/platform-client';

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_PHASES: UpdatePhase[] = ['complete', 'failed'];

function detectChannel(version: string | null | undefined): VersionChannel {
  if (!version) return 'stable';
  return version.startsWith('dev-') ? 'dev' : 'stable';
}

function isNewerStable(current: string, latest: string): boolean {
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

export function InstanceUpdateDialog({
  sandbox,
  open,
  onClose,
  onCompleted,
}: {
  sandbox: SandboxInfo | null;
  open: boolean;
  onClose: () => void;
  /** Fired after a successful update so the caller can refresh the sandbox list. */
  onCompleted?: () => void;
}) {
  // ── Version discovery ───────────────────────────────────────────────────
  const currentVersion = (sandbox?.version as string | null | undefined) ?? null;
  const channel = useMemo(() => detectChannel(currentVersion), [currentVersion]);

  const latestQuery = useQuery({
    queryKey: ['sandbox', 'latest-version', channel],
    queryFn: () => getLatestSandboxVersion(channel),
    enabled: open && !!sandbox,
    staleTime: 5 * 60 * 1000,
  });

  const latestVersion = latestQuery.data?.version ?? null;
  const changelog = latestQuery.data?.changelog ?? null;

  // ── Update lifecycle (polled) ───────────────────────────────────────────
  const [liveStatus, setLiveStatus] = useState<SandboxUpdateStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; currentVersion: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
    if (!pollActiveRef.current || !sandbox) return;
    try {
      const status = await getSandboxUpdateStatus(sandbox);
      setLiveStatus(status);

      if (TERMINAL_PHASES.includes(status.phase)) {
        stopPolling();
        if (status.phase === 'complete') {
          const finalVersion = status.currentVersion || latestVersion || currentVersion || '0.0.0';
          setUpdateResult({ success: true, currentVersion: finalVersion });
          onCompleted?.();
        } else if (status.phase === 'failed') {
          setUpdateResult({ success: false, currentVersion: status.currentVersion || currentVersion || '0.0.0' });
          setErrorMessage(status.error ?? status.message ?? 'Update failed');
        }
        return;
      }
    } catch {
      // kortix-api may be momentarily unreachable during container recreate —
      // keep polling, the next tick usually recovers.
    }
    if (pollActiveRef.current) {
      pollRef.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
    }
  }, [sandbox, latestVersion, currentVersion, stopPolling, onCompleted]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollActiveRef.current = true;
    setIsPolling(true);
    setUpdateResult(null);
    setErrorMessage(null);
    pollRef.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
  }, [pollStatus, stopPolling]);

  // Reset everything when the dialog closes.
  useEffect(() => {
    if (!open) {
      stopPolling();
      setLiveStatus(null);
      setUpdateResult(null);
      setErrorMessage(null);
    }
  }, [open, stopPolling]);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      pollActiveRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const triggerUpdate = useCallback(
    async (targetVersion?: string) => {
      if (!sandbox) return;
      const versionToInstall = targetVersion || latestVersion;
      if (!versionToInstall) {
        sonnerToast.error('No target version available');
        return;
      }
      try {
        setErrorMessage(null);
        startPolling();
        await triggerSandboxUpdate(sandbox, versionToInstall);
      } catch (err) {
        stopPolling();
        const msg = err instanceof Error ? err.message : 'Failed to start update';
        setErrorMessage(msg);
        setUpdateResult({ success: false, currentVersion: currentVersion ?? '0.0.0' });
        setLiveStatus((prev) =>
          prev
            ? { ...prev, phase: 'failed', message: 'Update failed', error: msg }
            : {
                phase: 'failed',
                progress: 0,
                message: 'Update failed',
                targetVersion: versionToInstall,
                previousVersion: currentVersion,
                currentVersion: currentVersion,
                error: msg,
                startedAt: null,
                updatedAt: null,
              },
        );
      }
    },
    [sandbox, latestVersion, currentVersion, startPolling, stopPolling],
  );

  // ── Derived UI state ────────────────────────────────────────────────────
  const phase: UpdatePhase = liveStatus?.phase ?? 'idle';
  const phaseProgress = liveStatus?.progress ?? 0;
  const phaseMessage = liveStatus?.message ?? '';

  // Only let users close the dialog when we're not mid-update — avoids
  // accidentally leaving the install running with no UI to watch it.
  const canClose = !isPolling || phase === 'complete' || phase === 'failed';

  return (
    <UpdateDialog
      open={open}
      phase={phase}
      phaseMessage={phaseMessage}
      phaseProgress={phaseProgress}
      latestVersion={latestVersion}
      changelog={changelog}
      currentVersion={currentVersion}
      isLocalSelfHosted={false}
      errorMessage={errorMessage}
      updateResult={updateResult}
      onClose={() => {
        if (canClose) onClose();
      }}
      onConfirm={() => triggerUpdate()}
      onRetry={() => triggerUpdate()}
    />
  );
}

/**
 * Utility: check whether a sandbox has a newer version available, without
 * rendering the dialog. Currently unused but handy for future "update
 * available" badges on the instance card.
 */
export function hasNewerVersion(currentVersion: string | null, latestVersion: string | null): boolean {
  if (!currentVersion || !latestVersion) return false;
  if (currentVersion.startsWith('dev-')) return currentVersion !== latestVersion;
  return isNewerStable(currentVersion, latestVersion);
}
