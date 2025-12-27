import { SpreadsheetComponent } from '@syncfusion/ej2-react-spreadsheet';
import { registerLicense } from '@syncfusion/ej2-base';
import { ToolViewProps } from '../types';
import { getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Loader2, RefreshCw } from 'lucide-react';
import { useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { SpreadsheetSimulation } from './SpreadsheetSimulation';
import { SpreadsheetLoader } from './SpreadsheetLoader';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { useSpreadsheetSync } from './useSpreadsheetSync';

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


const SYNCFUSION_LICENSE = "Ngo9BigBOggjHTQxAR8/V1JGaF5cXGpCf0x0QHxbf1x2ZFFMYFtbRHZPMyBoS35Rc0RhW3ledHRSRmVeVUx+VEFf";
const SYNCFUSION_BASE_URL = 'https://ej2services.syncfusion.com/production/web-services/api/spreadsheet';

registerLicense(SYNCFUSION_LICENSE);

export function SpreadsheetToolView({
  toolCall,
  toolResult,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const ssRef = useRef<SpreadsheetComponent>(null);
  const sandboxId = project?.sandbox?.id;

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

  const {
    syncState,
    isLoading,
    handlers,
    actions,
  } = useSpreadsheetSync({
    sandboxId,
    filePath,
    spreadsheetRef: ssRef,
    enabled: !isStreaming,
    debounceMs: 1500,
    maxRetries: 3,
    pollIntervalMs: 5000,
  });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-green-100 dark:bg-green-900/50 border-green-300 dark:border-green-700">
              {isLoading || isStreaming ? (
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
              onClick={actions.forceRefresh}
              disabled={isLoading || syncState.status === 'syncing'}
              className="h-7 px-2"
            >
              <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        <SpreadsheetComponent
          ref={ssRef}
          openUrl={`${SYNCFUSION_BASE_URL}/open`}
          saveUrl={`${SYNCFUSION_BASE_URL}/save`}
          showRibbon={true}
          showFormulaBar={true}
          showSheetTabs={true}
          allowEditing={true}
          allowOpen={true}
          allowSave={true}
          allowScrolling={true}
          allowResizing={true}
          allowCellFormatting={true}
          allowNumberFormatting={true}
          allowConditionalFormat={true}
          allowDataValidation={true}
          allowHyperlink={true}
          allowInsert={true}
          allowDelete={true}
          allowMerge={true}
          allowSorting={true}
          allowFiltering={true}
          allowWrap={true}
          allowFreezePane={true}
          allowUndoRedo={true}
          allowChart={true}
          allowImage={true}
          enableClipboard={true}
          cellEdit={handlers.handleCellEdit}
          cellSave={handlers.handleCellSave}
          actionComplete={handlers.handleActionComplete}
          openFailure={handlers.handleOpenFailure}
          beforeSave={handlers.handleBeforeSave}
          saveComplete={handlers.handleSaveComplete}
          created={handlers.handleCreated}
          openComplete={handlers.handleOpenComplete}
        />
        {isStreaming && (
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm">
            <SpreadsheetSimulation mode="max" />
          </div>
        )}
        {isLoading && !isStreaming && (
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm">
            <SpreadsheetLoader mode="max" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
