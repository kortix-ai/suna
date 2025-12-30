import { ToolViewProps } from '../types';
import { getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Loader2, Download, RefreshCw } from 'lucide-react';
import { useMemo, useState, useCallback } from 'react';
import { SpreadsheetSimulation } from './SpreadsheetSimulation';
import { SpreadsheetViewer, SyncState } from './SpreadsheetViewer';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { Button } from '@/components/ui/button';

export function SpreadsheetToolView({
  toolCall,
  toolResult,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const [syncState, setSyncState] = useState<SyncState>({ 
    status: 'idle', 
    lastSyncedAt: null, 
    pendingChanges: false, 
    retryCount: 0 
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [actions, setActions] = useState<{ 
    forceRefresh: () => Promise<boolean>; 
    forceSave: () => void; 
    resolveConflict: (keepLocal: boolean) => Promise<void> 
  }>({ 
    forceRefresh: async () => false, 
    forceSave: () => {},
    resolveConflict: async () => {} 
  });
  const [handleDownload, setHandleDownload] = useState<() => void>(() => () => {});

  const handleSyncStateChange = useCallback((state: SyncState) => {
    setSyncState(state);
  }, []);

  const handleLoadingChange = useCallback((loading: boolean) => {
    setIsLoading(loading);
  }, []);

  const handleActionsReady = useCallback((newActions: { 
    forceRefresh: () => Promise<boolean>; 
    forceSave: () => void; 
    resolveConflict: (keepLocal: boolean) => Promise<void> 
  }) => {
    setActions(newActions);
  }, []);

  const handleDownloadReady = useCallback((download: () => void) => {
    setHandleDownload(() => download);
  }, []);

  const handleDownloadingChange = useCallback((downloading: boolean) => {
    setIsDownloading(downloading);
  }, []);

  const filePath = useMemo(() => {
    if (toolResult?.output) {
      try {
        const output = typeof toolResult.output === 'string'
          ? JSON.parse(toolResult.output)
          : toolResult.output;
        if (output.file_path) return output.file_path;
      } catch {}
    }

    if (toolCall?.arguments?.file_path) {
      return toolCall.arguments.file_path;
    }

    return null;
  }, [toolCall, toolResult]);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);
  const fileName = filePath?.split('/').pop() || 'spreadsheet.xlsx';

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-green-100 dark:bg-green-900/50 border-green-300 dark:border-green-700">
              {isStreaming || isLoading ? (
                <Loader2 className="w-5 h-5 text-green-600 dark:text-green-400 animate-spin" />
              ) : (
                <Table className="w-5 h-5 text-green-600 dark:text-green-400" />
              )}
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
              {isStreaming && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Updating...</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isStreaming && (
              <>
                <SyncStatusIndicator
                  status={syncState.status}
                  lastSyncedAt={syncState.lastSyncedAt}
                  pendingChanges={syncState.pendingChanges}
                  errorMessage={syncState.errorMessage}
                  onRefresh={actions.forceRefresh}
                  onResolveConflict={actions.resolveConflict}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDownload}
                  disabled={!filePath || isDownloading}
                  className="h-7 px-2"
                  title="Download file"
                >
                  {isDownloading ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Download className="w-3 h-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={actions.forceRefresh}
                  disabled={isLoading || syncState.status === 'syncing'}
                  className="h-7 px-2"
                >
                  <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm">
            <SpreadsheetSimulation mode="max" />
          </div>
        ) : (
          <SpreadsheetViewer
            filePath={filePath || undefined}
            fileName={fileName}
            project={project}
            showToolbar={false}
            allowEditing={true}
            onSyncStateChange={handleSyncStateChange}
            onLoadingChange={handleLoadingChange}
            onActionsReady={handleActionsReady}
            onDownloadReady={handleDownloadReady}
            onDownloadingChange={handleDownloadingChange}
          />
        )}
      </CardContent>
    </Card>
  );
}
