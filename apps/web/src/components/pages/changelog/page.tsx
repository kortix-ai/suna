'use client';

import { useCallback, useState } from 'react';

import { useGlobalSandboxUpdate, detectChannel } from '@/hooks/platform/use-global-sandbox-update';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useUpdateDialogStore } from '@/stores/update-dialog-store';
import { VersionHistoryPanel } from '@/components/changelog/version-history-panel';

export default function ChangelogPage() {
  const currentVersion = useSandboxConnectionStore((s) => s.sandboxVersion);
  const currentChannel = detectChannel(currentVersion);
  const { updateAvailable, latestVersion, isUpdating } = useGlobalSandboxUpdate();
  const [showDev] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (currentChannel === 'dev') return true;
    return localStorage.getItem('changelog-show-dev') === 'true';
  });
  const openDialog = useUpdateDialogStore((s) => s.openDialog);

  const handleInstall = useCallback((version: string) => {
    openDialog(version);
  }, [openDialog]);

  const handleUpdate = useCallback(() => {
    openDialog();
  }, [openDialog]);

  return (
    <div className="flex-1 overflow-y-auto">
      <VersionHistoryPanel
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        updateAvailable={updateAvailable}
        isUpdating={isUpdating}
        onUpdateLatest={handleUpdate}
        onInstallVersion={handleInstall}
        initialShowDev={showDev}
      />
    </div>
  );
}
