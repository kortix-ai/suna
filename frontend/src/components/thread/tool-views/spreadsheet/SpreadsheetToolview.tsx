import { SpreadsheetComponent } from '@syncfusion/ej2-react-spreadsheet';
import { registerLicense } from '@syncfusion/ej2-base';
import { ToolViewProps } from '../types';
import { getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Loader2, RefreshCw, Save } from 'lucide-react';
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { getSandboxFileContent, createSandboxFileJson } from '@/lib/api/sandbox';
import { Button } from '@/components/ui/button';

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

interface SpreadsheetJsonData {
  version: string;
  sheets: Array<{
    name: string;
    rows?: Array<{
      cells: Array<{
        value?: string;
        formula?: string;
        style?: Record<string, any>;
      }>;
    }>;
    columns?: Array<{ width: number }>;
    rowCount?: number;
    colCount?: number;
  }>;
  activeSheet: number;
}


function convertJsonToSyncfusionSheets(data: SpreadsheetJsonData): any[] {
    if (!data?.sheets?.length) return createEmptySheet();
  
    return data.sheets.map(sheet => {
      const rows = (sheet.rows || []).map(row => ({
        cells: (row.cells || []).map(cell => {
          const out: any = {};
  
          if (cell.formula) {
            out.value = cell.formula;
          } else if (cell.value !== undefined) {
            out.value = cell.value;
          }
  
          if (cell.style) out.style = cell.style;
  
          return out;
        })
      }));
  
      let maxCol = 0;
      rows.forEach(r => maxCol = Math.max(maxCol, r.cells.length));
  
      return {
        name: sheet.name || 'Sheet1',
        rows,
        columns: sheet.columns || Array.from({ length: maxCol || 8 }, () => ({ width: 100 })),
        usedRange: {
          rowIndex: rows.length - 1,
          colIndex: Math.max(maxCol - 1, 0)
        }
      };
    });
  }
  

function createEmptySheet() {
  return [{
    name: 'Sheet1',
    rows: [],
    columns: [
      { width: 100 }, { width: 100 }, { width: 100 }, { width: 100 },
      { width: 100 }, { width: 100 }, { width: 100 }, { width: 100 }
    ],
    rowCount: 100,
    colCount: 26
  }];
}

function buildSheetsFromArguments(args: Record<string, any>): any[] | null {
  if (!args) return null;
  
  const headers = args.headers as string[] | undefined;
  const rows = args.rows as any[][] | undefined;
  
  if (headers && rows) {
    const allRows: any[] = [];
    allRows.push({
      cells: headers.map(h => ({ 
        value: String(h ?? ''), 
        style: { fontWeight: 'bold', backgroundColor: '#1F4E79', color: '#FFFFFF' } 
      }))
    });
    for (const row of rows) {
      allRows.push({
        cells: (row || []).map(cell => ({ value: String(cell ?? '') }))
      });
    }
    
    const columns = headers.map(() => ({ width: 100 }));
    return [{
      name: args.sheet_name || 'Sheet1',
      rows: allRows,
      columns,
      rowCount: Math.max(allRows.length + 50, 100),
      colCount: Math.max(headers.length + 5, 26)
    }];
  }
  
  return null;
}

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
  const [sheets, setSheets] = useState<any[]>(createEmptySheet());
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [dataSource, setDataSource] = useState<'streaming' | 'file'>('streaming');
  
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

  const streamingSheets = useMemo(() => {
    if (!toolCall?.arguments) return null;
    return buildSheetsFromArguments(toolCall.arguments);
  }, [toolCall?.arguments]);

  const loadSpreadsheetData = useCallback(async (): Promise<boolean> => {
    if (!sandboxId || !filePath) return false;

    setIsLoading(true);

    try {
      const content = await getSandboxFileContent(sandboxId, filePath);
      let jsonData: SpreadsheetJsonData;
      if (typeof content === 'string') {
        jsonData = JSON.parse(content);
      } else if (content instanceof Blob) {
        const text = await content.text();
        jsonData = JSON.parse(text);
      } else {
        jsonData = content as SpreadsheetJsonData;
      }
      
      const syncfusionSheets = convertJsonToSyncfusionSheets(jsonData);
      setSheets(syncfusionSheets);
      setDataSource('file');
      setLastUpdate(Date.now());
      
      if (ssRef.current) {
        try {
            ssRef.current.openFromJson({
                file: {
                    sheets: syncfusionSheets,
                    activeSheetIndex: 0
                }
            });
        } catch (e) {
          console.warn('[Spreadsheet] openFromJson failed, using refresh:', e);
          try {
            ssRef.current.sheets = syncfusionSheets;
            ssRef.current.refresh();
          } catch (e2) {}
        }
      }
      return true;
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      const isNotFound = errorMsg.includes('not found') || 
                         errorMsg.includes('404') || 
                         errorMsg.includes('No such file') ||
                         errorMsg.includes('does not exist');
      if (!isNotFound) {
        console.warn('Spreadsheet load error:', errorMsg);
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [sandboxId, filePath]);

  useEffect(() => {
    if (sandboxId && filePath) {
      loadSpreadsheetData();
    }
  }, [sandboxId, filePath]);

  useEffect(() => {
    if (isStreaming && streamingSheets) {
      setSheets(streamingSheets);
      setDataSource('streaming');
      setLastUpdate(Date.now());
    }
  }, [streamingSheets]);

  const prevIsStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    
    if (wasStreaming && !isStreaming && sandboxId) {
      setTimeout(() => loadSpreadsheetData(), 500);
    }
  }, [isStreaming, sandboxId, loadSpreadsheetData]);

  const handleSave = useCallback(async () => {
    if (!sandboxId || !ssRef.current || !filePath) return;
    
    setIsSaving(true);
    try {
      const spreadsheet = ssRef.current;
      const sheetsData: SpreadsheetJsonData = {
        version: "1.0",
        sheets: [],
        activeSheet: 0
      };

      const sheetCount = spreadsheet.sheets?.length || 1;
      
      for (let sheetIdx = 0; sheetIdx < sheetCount; sheetIdx++) {
        const sheetModel = spreadsheet.sheets?.[sheetIdx];
        const rows: Array<{ cells: Array<{ value?: string; formula?: string; style?: any }> }> = [];
        
        if (sheetModel?.rows) {
            sheetModel.rows.forEach((row: any) => {
                const cellsArr: any[] = [];
              
                (row.cells || []).forEach((cell: any) => {
                  if (!cell) {
                    cellsArr.push({});
                    return;
                  }
                  if (typeof cell.value === 'string' && cell.value.startsWith('=')) {
                    cellsArr.push({
                      formula: cell.value,
                      style: cell.style
                    });
                  } else {
                    cellsArr.push({
                      value: cell.value ?? '',
                      style: cell.style
                    });
                  }
                });
              
                rows.push({ cells: cellsArr });
              });              
        }

        const columns: Array<{ width: number }> = [];
        if (sheetModel?.columns) {
          sheetModel.columns.forEach((col: any) => {
            columns.push({ width: col?.width || 100 });
          });
        }

        sheetsData.sheets.push({
          name: sheetModel?.name || `Sheet${sheetIdx + 1}`,
          rows,
          columns: columns.length > 0 ? columns : [{ width: 100 }],
          rowCount: rows.length + 50,
          colCount: columns.length || 26
        });
      }

      await createSandboxFileJson(sandboxId, filePath, JSON.stringify(sheetsData, null, 2));
      setHasUnsavedChanges(false);
    } catch (e) {
      console.error('Failed to save spreadsheet:', e);
    } finally {
      setIsSaving(false);
    }
  }, [sandboxId, filePath]);

  const handleCellEdit = useCallback(() => {
    setHasUnsavedChanges(true);
  }, []);

  const sheetsKey = useMemo(() => {
    return `spreadsheet-${lastUpdate}-${sheets.length}`;
  }, [sheets, lastUpdate]);

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
          key={sheetsKey}
          ref={ssRef}
          sheets={sheets}
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
          created={() => {
            if (sandboxId && sheets.length > 0 && sheets[0]?.rows?.length > 0) {
              setTimeout(() => {
                if (ssRef.current) {
                  try {
                    ssRef.current.refresh();
                  } catch (e) {}
                }
              }, 100);
            }
          }}
        />
      </CardContent>
    </Card>
  );
}
