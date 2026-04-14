'use client';

import { useState, useEffect, useRef } from 'react';
import { useUpdateDialogStore } from '@/stores/update-dialog-store';
import { useGlobalSandboxUpdate } from '@/hooks/platform/use-global-sandbox-update';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useServerStore } from '@/stores/server-store';
import { UpdateDialog } from '@/components/update-dialog';
import type { UpdatePhase } from '@/lib/platform-client';

const DEV_PHASES: UpdatePhase[] = ['pulling', 'patching', 'stopping', 'restarting', 'verifying', 'complete'];

export function UpdateDialogProvider() {
  const { open, targetVersion, closeDialog, openDialog } = useUpdateDialogStore();
  const currentVersion = useSandboxConnectionStore((s) => s.sandboxVersion);
  const activeServer = useServerStore((s) => {
    const id = s.activeServerId;
    return id ? s.servers.find((sv) => sv.id === id) : undefined;
  });
  const isLocalSelfHosted = activeServer?.provider === 'local_docker';
  const {
    phase, phaseMessage, phaseProgress, latestVersion,
    changelog, updateResult, update, updateErrorMessage,
    isDestructive, isUpdating,
  } = useGlobalSandboxUpdate();

  useEffect(() => {
    if (open && isUpdating && !isDestructive) closeDialog();
  }, [open, isUpdating, isDestructive, closeDialog]);

  useEffect(() => {
    if (!open && isDestructive) openDialog();
  }, [open, isDestructive, openDialog]);

  const [devMode, setDevMode] = useState(false);
  const [devPhaseIdx, setDevPhaseIdx] = useState(0);
  const devModeRef = useRef(devMode);
  devModeRef.current = devMode;

  const devPhase = devMode ? DEV_PHASES[devPhaseIdx] : phase;
  const devProgress = devMode ? Math.round((devPhaseIdx / (DEV_PHASES.length - 1)) * 100) : phaseProgress;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'U') {
        e.preventDefault();
        if (!devModeRef.current) {
          setDevMode(true);
          setDevPhaseIdx(0);
          openDialog();
        } else {
          setDevMode(false);
          closeDialog();
        }
      }
      if (devModeRef.current && e.key === 'ArrowRight') {
        e.preventDefault();
        setDevPhaseIdx((prev) => Math.min(prev + 1, DEV_PHASES.length - 1));
      }
      if (devModeRef.current && e.key === 'ArrowLeft') {
        e.preventDefault();
        setDevPhaseIdx((prev) => Math.max(prev - 1, 0));
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openDialog, closeDialog]);

  return (
    <UpdateDialog
      open={open}
      phase={devPhase}
      phaseMessage={devMode ? `Dev: ${devPhase}` : phaseMessage}
      phaseProgress={devProgress}
      latestVersion={targetVersion ?? latestVersion ?? null}
      changelog={changelog}
      currentVersion={currentVersion ?? null}
      isLocalSelfHosted={isLocalSelfHosted}
      errorMessage={updateErrorMessage}
      updateResult={devMode && devPhase === 'complete' ? { success: true, currentVersion: '0.8.20' } : updateResult}
      onClose={() => { if (devMode) setDevMode(false); closeDialog(); }}
      onConfirm={() => { if (devMode) { setDevPhaseIdx(1); return; } update(targetVersion ?? undefined); }}
      onRetry={() => { if (devMode) { setDevPhaseIdx(1); return; } update(targetVersion ?? undefined); }}
      isDev={devMode}
    />
  );
}
