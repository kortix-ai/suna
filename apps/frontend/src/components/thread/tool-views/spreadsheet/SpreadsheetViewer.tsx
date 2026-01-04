'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { SpreadsheetComponent } from '@syncfusion/ej2-react-spreadsheet';
import { registerLicense } from '@syncfusion/ej2-base';
import { Loader2, FileSpreadsheet, Download, RefreshCw, Cloud, CloudOff, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSpreadsheetSync } from './useSpreadsheetSync';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/components/AuthProvider';
import { toast } from 'sonner';
import { useDownloadRestriction } from '@/hooks/billing';
import { SpreadsheetLoader } from './SpreadsheetLoader';

import '../../../../../node_modules/@syncfusion/ej2-base/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-inputs/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-buttons/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-splitbuttons/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-lists/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-navigations/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-popups/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-dropdowns/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-grids/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-react-spreadsheet/styles/material.css';
import './kortix-spreadsheet-styles.css';


const SYNCFUSION_LICENSE = "Ngo9BigBOggjHTQxAR8/V1JGaF5cXGpCf0x0QHxbf1x2ZFFMYFtbRHZPMyBoS35Rc0RhW3ledHRSRmVeVUx+VEFf";
const SYNCFUSION_BASE_URL = 'https://ej2services.syncfusion.com/production/web-services/api/spreadsheet';

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
  onActionsReady?: (actions: { forceRefresh: () => Promise<boolean>; forceSave: () => void; resolveConflict: (keepLocal: boolean) => Promise<void> }) => void;
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
      sandboxId: resolvedSandboxId
    });
    
    return path;
  })();

  const {
    syncState,
    isLoading,
    handlers,
    actions,
  } = useSpreadsheetSync({
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
    
    if (!resolvedSandboxId || !resolvedFilePath || !session?.access_token) {
      console.error('[SpreadsheetViewer] Download failed - missing:', {
        resolvedSandboxId,
        resolvedFilePath,
        hasSession: !!session?.access_token
      });
      toast.error('Unable to download file');
      return;
    }

    console.log('[SpreadsheetViewer] Downloading:', {
      sandboxId: resolvedSandboxId,
      filePath: resolvedFilePath,
      fileName
    });

    setIsDownloading(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${resolvedSandboxId}/files/content?path=${encodeURIComponent(resolvedFilePath)}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success('File downloaded successfully');
    } catch (error) {
      console.error('[SpreadsheetViewer] Download error:', error);
      toast.error('Failed to download file');
    } finally {
      setIsDownloading(false);
    }
  }, [resolvedSandboxId, resolvedFilePath, fileName, session, isDownloadRestricted, openUpgradeModal]);

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
        return <Cloud className="w-3 h-3 text-blue-500 animate-pulse" />;
      case 'synced':
        return <Cloud className="w-3 h-3 text-emerald-500" />;
      case 'offline':
        return <CloudOff className="w-3 h-3 text-amber-500" />;
      case 'error':
      case 'conflict':
        return <AlertCircle className="w-3 h-3 text-red-500" />;
      default:
        return syncState.pendingChanges 
          ? <Cloud className="w-3 h-3 text-zinc-400" />
          : <Cloud className="w-3 h-3 text-zinc-400" />;
    }
  };

  if (!resolvedFilePath) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-foreground">No file path provided</h3>
            <p className="text-xs text-muted-foreground">FilePath is required to load the spreadsheet</p>
          </div>
        </div>
      </div>
    );
  }

  if (syncState.status === 'error' && isLoading) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-foreground">Failed to load spreadsheet</h3>
            <p className="text-xs text-muted-foreground">{syncState.errorMessage || 'Unknown error'}</p>
            {resolvedFilePath && (
              <p className="text-xs text-muted-foreground mt-1">Path: {resolvedFilePath}</p>
            )}
            <Button
              onClick={actions.forceRefresh}
              variant="outline"
              size="sm"
              className="mt-3"
            >
              <RefreshCw className="w-3 h-3 mr-2" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('w-full h-full relative flex flex-col', className)}>
      <div className="flex-1 relative">
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
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm">
            <SpreadsheetLoader mode="max" />
          </div>
        )}
      </div>
    </div>
  );
}
