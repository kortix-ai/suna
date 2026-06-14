'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { useDownloadRestriction } from '@/hooks/billing';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { registerLicense } from '@syncfusion/ej2-base';
import { SpreadsheetComponent } from '@syncfusion/ej2-react-spreadsheet';
import { AlertCircle, Cloud, CloudOff, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SpreadsheetLoader } from './SpreadsheetLoader';
import { useSpreadsheetSync } from './useSpreadsheetSync';

import '../../../../../node_modules/@syncfusion/ej2-base/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-buttons/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-dropdowns/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-grids/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-inputs/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-lists/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-navigations/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-popups/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-react-spreadsheet/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-splitbuttons/styles/material.css';
import './kortix-spreadsheet-styles.css';

const SYNCFUSION_LICENSE =
  'Ngo9BigBOggjHTQxAR8/V1JGaF5cXGpCfEx0QXxbf1x2ZFRMZVxbQXNPIiBoS35RcEViW3pfc3FXQmJYUkZ3VEFf';
const SYNCFUSION_BASE_URL =
  'https://ej2services.syncfusion.com/production/web-services/api/spreadsheet';

registerLicense(SYNCFUSION_LICENSE);

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'conflict';

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt: number | null;
  pendingChanges: boolean;
  errorMessage?: string;
  retryCount: number;
}

interface SpreadsheetViewerProps {
  filePath?: string;
  fileName: string;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
    };
  };
  compact?: boolean;
  showToolbar?: boolean;
  showDownloadButton?: boolean;
  allowEditing?: boolean;
  onSyncStateChange?: (state: SyncState) => void;
  onActionsReady?: (actions: {
    forceRefresh: () => Promise<boolean>;
    forceSave: () => void;
    resolveConflict: (keepLocal: boolean) => Promise<void>;
  }) => void;
  onLoadingChange?: (isLoading: boolean) => void;
  onDownloadReady?: (download: () => void) => void;
  onDownloadingChange?: (isDownloading: boolean) => void;
}

export function SpreadsheetViewer({
  filePath,
  fileName,
  className,
  sandboxId,
  project,
  compact = false,
  showToolbar = true,
  showDownloadButton = true,
  allowEditing = true,
  onSyncStateChange,
  onActionsReady,
  onLoadingChange,
  onDownloadReady,
  onDownloadingChange,
}: SpreadsheetViewerProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const ssRef = useRef<SpreadsheetComponent>(null);
  const { session } = useAuth();
  const [isDownloading, setIsDownloading] = useState(false);
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'files',
  });

  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      .e-popup,
      .e-popup-open,
      .e-dropdown-popup,
      .e-colorpicker-popup,
      .e-dialog,
      .e-menu-wrapper,
      .e-contextmenu-wrapper,
      .e-ul,
      .e-menu-popup {
        z-index: 999999 !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  const resolvedSandboxId = sandboxId || project?.sandbox?.id;

  const resolvedFilePath = (() => {
    if (!filePath) {
      console.warn('[SpreadsheetViewer] No filePath provided, only fileName:', fileName);
      return null;
    }

    let path = filePath;

    if (path.startsWith('blob:')) {
      console.log('[SpreadsheetViewer] Using blob URL:', path);
      return path;
    }

    if (!path.startsWith('/')) {
      if (path.startsWith('workspace')) {
        path = '/' + path;
      } else if (!path.includes('workspace')) {
        path = `/workspace/${path}`;
      }
    }

    console.log('[SpreadsheetViewer] Resolved path:', {
      original: filePath,
      resolved: path,
      fileName,
      sandboxId: resolvedSandboxId,
    });

    return path;
  })();

  const { syncState, isLoading, handlers, actions } = useSpreadsheetSync({
    sandboxId: resolvedSandboxId,
    filePath: resolvedFilePath,
    spreadsheetRef: ssRef,
    enabled: !!resolvedSandboxId && !!resolvedFilePath,
    debounceMs: 1500,
    maxRetries: 3,
    pollIntervalMs: 30000, // 30 seconds - only poll for external changes when idle
  });

  useEffect(() => {
    if (onSyncStateChange) {
      onSyncStateChange(syncState);
    }
  }, [syncState, onSyncStateChange]);

  useEffect(() => {
    if (onLoadingChange) {
      onLoadingChange(isLoading);
    }
  }, [isLoading, onLoadingChange]);

  useEffect(() => {
    if (onActionsReady) {
      onActionsReady(actions);
    }
  }, [actions, onActionsReady]);

  const handleDownload = useCallback(async () => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }

    if (!resolvedFilePath) {
      toast.error('Unable to download file');
      return;
    }

    setIsDownloading(true);
    try {
      const { downloadFile } = await import('@/features/files/api/opencode-files');
      await downloadFile(resolvedFilePath, fileName);
      toast.success('File downloaded successfully');
    } catch (error) {
      console.error('[SpreadsheetViewer] Download error:', error);
      toast.error('Failed to download file');
    } finally {
      setIsDownloading(false);
    }
  }, [resolvedFilePath, fileName, isDownloadRestricted, openUpgradeModal]);

  useEffect(() => {
    if (onDownloadReady) {
      onDownloadReady(handleDownload);
    }
  }, [handleDownload, onDownloadReady]);

  useEffect(() => {
    if (onDownloadingChange) {
      onDownloadingChange(isDownloading);
    }
  }, [isDownloading, onDownloadingChange]);

  const getSyncIcon = () => {
    switch (syncState.status) {
      case 'syncing':
        return <Cloud className="h-3 w-3 animate-pulse text-zinc-500 dark:text-zinc-400" />;
      case 'synced':
        return <Cloud className="h-3 w-3 text-zinc-500 dark:text-zinc-400" />;
      case 'offline':
        return <CloudOff className="h-3 w-3 text-amber-500" />;
      case 'error':
      case 'conflict':
        return <AlertCircle className="h-3 w-3 text-red-500" />;
      default:
        return syncState.pendingChanges ? (
          <Cloud className="h-3 w-3 text-zinc-400" />
        ) : (
          <Cloud className="h-3 w-3 text-zinc-400" />
        );
    }
  };

  if (!resolvedFilePath) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="space-y-3 text-center">
          <div className="bg-muted mx-auto flex h-16 w-16 items-center justify-center rounded-full">
            <FileSpreadsheet className="text-muted-foreground h-8 w-8" />
          </div>
          <div>
            <h3 className="text-foreground text-lg font-medium">
              {tHardcodedUi.raw(
                'componentsThreadToolViewsSpreadsheetSpreadsheetviewer.line237JsxTextNoFilePathProvided',
              )}
            </h3>
            <p className="text-muted-foreground text-xs">
              {tHardcodedUi.raw(
                'componentsThreadToolViewsSpreadsheetSpreadsheetviewer.line238JsxTextFilepathIsRequiredToLoadTheSpreadsheet',
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (syncState.status === 'error' && isLoading) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="space-y-3 text-center">
          <div className="bg-muted mx-auto flex h-16 w-16 items-center justify-center rounded-full">
            <FileSpreadsheet className="text-muted-foreground h-8 w-8" />
          </div>
          <div>
            <h3 className="text-foreground text-lg font-medium">
              {tHardcodedUi.raw(
                'componentsThreadToolViewsSpreadsheetSpreadsheetviewer.line253JsxTextFailedToLoadSpreadsheet',
              )}
            </h3>
            <p className="text-muted-foreground text-xs">
              {syncState.errorMessage || 'Unknown error'}
            </p>
            {resolvedFilePath && (
              <p className="text-muted-foreground mt-1 text-xs">Path: {resolvedFilePath}</p>
            )}
            <Button onClick={actions.forceRefresh} variant="outline" size="sm" className="mt-3">
              <RefreshCw className="mr-2 h-3 w-3" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('relative flex h-full w-full flex-col', className)}>
      <div className="relative flex-1">
        <SpreadsheetComponent
          ref={ssRef}
          openUrl={`${SYNCFUSION_BASE_URL}/open`}
          saveUrl={`${SYNCFUSION_BASE_URL}/save`}
          showRibbon={!compact && allowEditing}
          showFormulaBar={!compact && allowEditing}
          showSheetTabs={true}
          allowEditing={allowEditing}
          allowOpen={true}
          allowSave={allowEditing}
          allowScrolling={true}
          allowResizing={allowEditing}
          allowCellFormatting={allowEditing}
          allowNumberFormatting={allowEditing}
          allowConditionalFormat={allowEditing}
          allowDataValidation={allowEditing}
          allowHyperlink={allowEditing}
          allowInsert={allowEditing}
          allowDelete={allowEditing}
          allowMerge={allowEditing}
          allowSorting={true}
          allowFiltering={true}
          allowWrap={allowEditing}
          allowFreezePane={allowEditing}
          allowUndoRedo={allowEditing}
          allowChart={allowEditing}
          allowImage={allowEditing}
          enableClipboard={true}
          cellEdit={handlers.handleCellEdit}
          cellSave={handlers.handleCellSave}
          actionComplete={handlers.handleActionComplete}
          beforeSave={handlers.handleBeforeSave}
          saveComplete={handlers.handleSaveComplete}
          created={handlers.handleCreated}
          openComplete={handlers.handleOpenComplete}
          openFailure={handlers.handleOpenFailure}
        />
        {isLoading && (
          <div className="bg-background/95 absolute inset-0 z-50 backdrop-blur-sm">
            <SpreadsheetLoader mode="max" />
          </div>
        )}
      </div>
    </div>
  );
}
