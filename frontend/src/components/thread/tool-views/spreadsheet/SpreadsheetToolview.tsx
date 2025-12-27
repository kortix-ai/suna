import { SpreadsheetComponent } from '@syncfusion/ej2-react-spreadsheet';
import { registerLicense } from '@syncfusion/ej2-base';
import { ToolViewProps } from '../types';
import { getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Loader2, RefreshCw, Save } from 'lucide-react';
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { getSandboxFileContent } from '@/lib/api/sandbox';
import { Button } from '@/components/ui/button';
import { backendApi } from '@/lib/api-client';
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


registerLicense(
    "Ngo9BigBOggjHTQxAR8/V1JGaF5cXGpCf0x0QHxbf1x2ZFFMYFtbRHZPMyBoS35Rc0RhW3ledHRSRmVeVUx+VEFf"
);

export function SpreadsheetToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const ssRef = useRef<SpreadsheetComponent>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isComponentReady, setIsComponentReady] = useState(false);
  
  const sandboxId = project?.sandbox?.id;
 
  const filePath = useMemo(() => {
    if (toolResult?.output) {
      try {
        const output = typeof toolResult.output === 'string' 
          ? JSON.parse(toolResult.output) 
          : toolResult.output;
        if (output.file_path) return output.file_path;
      } catch (e) {}
    }
    
    if (toolCall?.arguments?.file_path) {
      return toolCall.arguments.file_path;
    }
    
    return null;
  }, [toolCall, toolResult]);

  const loadSpreadsheetData = useCallback(async (): Promise<boolean> => {
    if (!sandboxId || !filePath) {
      console.warn('[Spreadsheet] Missing sandboxId or filePath:', { sandboxId, filePath });
      return false;
    }

    setIsLoading(true);
    console.log('[Spreadsheet] Starting load...', { sandboxId, filePath });

    try {
      const content = await getSandboxFileContent(sandboxId, filePath);
      console.log('[Spreadsheet] Content received:', {
        type: content?.constructor?.name,
        isBlob: content instanceof Blob,
        size: content instanceof Blob ? content.size : (typeof content === 'string' ? content.length : 'unknown')
      });
      
      const fileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
      const fileExt = fileName.split('.').pop()?.toLowerCase();
      
      let mimeType = 'application/octet-stream';
      if (fileExt === 'xlsx') {
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (fileExt === 'xls') {
        mimeType = 'application/vnd.ms-excel';
      } else if (fileExt === 'csv') {
        mimeType = 'text/csv';
      }
      
      console.log('[Spreadsheet] File info:', { fileName, fileExt, mimeType });
      
      let fileBlob: Blob;
      if (content instanceof Blob) {
        console.log('[Spreadsheet] Content is Blob, recreating with correct MIME type');
        fileBlob = new Blob([content], { type: mimeType });
      } else if (typeof content === 'string') {
        console.log('[Spreadsheet] Content is string, creating Blob');
        fileBlob = new Blob([content], { type: mimeType });
      } else {
        console.log('[Spreadsheet] Content is object, stringifying');
        fileBlob = new Blob([JSON.stringify(content)], { type: mimeType });
      }

      const file = new File([fileBlob], fileName, { type: mimeType });
      console.log('[Spreadsheet] File created:', { 
        name: file.name, 
        type: file.type, 
        size: file.size
      });
      
      if (!ssRef.current) {
        console.error('[Spreadsheet] ssRef.current is null!');
        return false;
      }

      console.log('[Spreadsheet] Calling open() on Syncfusion component...');
      try {
        ssRef.current.open({ file: file });
        console.log('[Spreadsheet] ✅ open() call initiated');
      } catch (openError) {
        console.error('[Spreadsheet] ❌ Error in open():', openError);
        throw openError;
      }
      
      return true;
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      console.error('[Spreadsheet] Load error:', errorMsg);
      setIsLoading(false);
      return false;
    }
  }, [sandboxId, filePath]);

  useEffect(() => {
    if (sandboxId && filePath && !isStreaming && isComponentReady && !isLoading) {
      console.log('[Spreadsheet] Loading file...');
      loadSpreadsheetData();
    }
  }, [sandboxId, filePath, isStreaming, isComponentReady]);

  const handleSave = useCallback(() => {
    if (!ssRef.current) {
      console.warn('[Spreadsheet] Cannot save - ref is null');
      return;
    }
    
    if (!sandboxId || !filePath) {
      console.error('[Spreadsheet] Missing sandboxId or filePath');
      return;
    }
    
    const fileExt = filePath.split('.').pop()?.toLowerCase();
    const saveType = fileExt === 'csv' ? 'Csv' : 'Xlsx';
    const fileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
    
    console.log('[Spreadsheet] Ending edit mode and triggering save...', { filePath, saveType });
    
    ssRef.current.endEdit();
    
    setIsSaving(true);
    
    ssRef.current.save({
      saveType: saveType,
      fileName: fileName,
    });
  }, [filePath, sandboxId]);

  const handleBeforeSave = useCallback((args: any) => {
    console.log('[Spreadsheet] beforeSave triggered', args);
    args.needBlobData = true;
    args.isFullPost = false;
  }, []);

  const handleSaveComplete = useCallback(async (args: any) => {
    console.log('[Spreadsheet] saveComplete triggered', args);
    
    if (!sandboxId || !filePath) {
      console.error('[Spreadsheet] Missing sandboxId or filePath in saveComplete');
      setIsSaving(false);
      return;
    }
    
    try {
      const blob = args?.blobData;
      console.log('[Spreadsheet] Blob received:', { 
        hasBlobData: !!args?.blobData,
        blobType: blob?.type,
        blobSize: blob?.size 
      });
      
      if (!blob) {
        throw new Error('No blob data received from save');
      }
      
      const fileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
      const uploadFormData = new FormData();
      uploadFormData.append('path', filePath);
      uploadFormData.append('file', blob, fileName);
      console.log('[Spreadsheet] Uploading to backend...', { sandboxId, filePath, fileName });
      
      const response = await backendApi.uploadPut(`/sandboxes/${sandboxId}/files/binary`, uploadFormData, {
        showErrors: true,
      });
      
      if (response.error) {
        throw new Error(`Upload failed (${response.error.status}): ${response.error.message}`);
      }
      
      console.log('[Spreadsheet] ✅ File saved successfully');
      setHasUnsavedChanges(false);
    } catch (e: any) {
      console.error('[Spreadsheet] Save error:', e);
      alert('Failed to save: ' + (e.message || String(e)));
    } finally {
      setIsSaving(false);
    }
  }, [filePath, sandboxId]);

  const handleCellEdit = useCallback(() => {
    setHasUnsavedChanges(true);
  }, []);

  const handleOpenFailure = useCallback((args: any) => {
    console.error('[Spreadsheet] openFailure', args);
    setIsLoading(false);
  }, []);

  if (!toolCall) {
    console.warn('SpreadsheetToolView: toolCall is undefined.');
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
            {hasUnsavedChanges && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSave}
                disabled={isSaving}
                className="h-7 px-2 text-xs"
              >
                {isSaving ? (
                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                ) : (
                  <Save className="w-3 h-3 mr-1" />
                )}
                Save
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={loadSpreadsheetData}
              disabled={isLoading}
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
          openUrl="https://ej2services.syncfusion.com/production/web-services/api/spreadsheet/open"
          saveUrl="https://ej2services.syncfusion.com/production/web-services/api/spreadsheet/save"
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
          enableClipboard={true}
          cellEdit={handleCellEdit}
          openFailure={handleOpenFailure}
          beforeSave={handleBeforeSave}
          saveComplete={handleSaveComplete}
          created={() => {
            console.log('[Spreadsheet] Component created and ready');
            setIsComponentReady(true);
          }}
          openComplete={() => {
            console.log('[Spreadsheet] openComplete - file loaded!');
            setIsLoading(false);
          }}
        />
        {(isLoading || isStreaming) && (
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm">
            <SpreadsheetLoader mode="max" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
