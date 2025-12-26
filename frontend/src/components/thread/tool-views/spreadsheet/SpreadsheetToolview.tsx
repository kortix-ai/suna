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
    cells: Record<string, {
      value?: string;
      formula?: string;
      style?: Record<string, any>;
    }>;
    columns?: Record<string, { width: number }>;
    rowCount?: number;
    colCount?: number;
    frozenRows?: number;
    frozenColumns?: number;
  }>;
  activeSheet: number;
}

function convertJsonToSyncfusionSheets(data: SpreadsheetJsonData): any[] {
  return data.sheets.map((sheet) => {
    const rows: any[] = [];
    let maxRow = 0;
    let maxCol = 0;

    Object.keys(sheet.cells || {}).forEach((cellAddr) => {
      const match = cellAddr.match(/^([A-Z]+)(\d+)$/i);
      if (match) {
        const colStr = match[1].toUpperCase();
        const rowNum = parseInt(match[2], 10) - 1;
        
        let colNum = 0;
        for (let i = 0; i < colStr.length; i++) {
          colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
        }
        colNum -= 1;
        
        maxRow = Math.max(maxRow, rowNum);
        maxCol = Math.max(maxCol, colNum);
      }
    });

    for (let r = 0; r <= maxRow; r++) {
      const cells: any[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const colLetter = getColumnLetter(c);
        const cellAddr = `${colLetter}${r + 1}`;
        const cellData = sheet.cells?.[cellAddr];
        
        if (cellData) {
          cells.push({
            value: cellData.formula || cellData.value || '',
            style: cellData.style || {}
          });
        } else {
          cells.push({});
        }
      }
      rows.push({ cells });
    }

    const columns = [];
    for (let c = 0; c <= Math.max(maxCol, 7); c++) {
      const colWidth = sheet.columns?.[String(c)]?.width || 120;
      columns.push({ width: colWidth });
    }

    return {
      name: sheet.name,
      rows,
      columns,
      frozenRows: sheet.frozenRows || 0,
      frozenColumns: sheet.frozenColumns || 0
    };
  });
}

function getColumnLetter(colIndex: number): string {
  let result = "";
  let col = colIndex + 1;
  while (col > 0) {
    col -= 1;
    result = String.fromCharCode(65 + (col % 26)) + result;
    col = Math.floor(col / 26);
  }
  return result;
}

function createEmptySheet() {
  return [{
    name: 'Sheet1',
    rows: [],
    columns: [
      { width: 120 }, { width: 120 }, { width: 120 }, { width: 120 },
      { width: 120 }, { width: 120 }, { width: 120 }, { width: 120 }
    ],
  }];
}

function buildSheetsFromArguments(args: Record<string, any>): any[] | null {
  if (!args) return null;
  
  const headers = args.headers as string[] | undefined;
  const rows = args.rows as any[][] | undefined;
  const operations = args.operations as Array<{cell: string; value?: string; formula?: string}> | undefined;
  
  if (headers && rows) {
    const allRows: any[] = [];
    allRows.push({
      cells: headers.map(h => ({ 
        value: h, 
        style: { fontWeight: 'bold', backgroundColor: '#f3f4f6' } 
      }))
    });
    for (const row of rows) {
      allRows.push({
        cells: row.map(cell => ({ value: String(cell ?? '') }))
      });
    }
    
    const columns = headers.map(() => ({ width: 120 }));
    return [{
      name: 'Sheet1',
      rows: allRows,
      columns
    }];
  }
  
  if (operations && operations.length > 0) {
    const cells: Record<string, any> = {};
    let maxRow = 0;
    let maxCol = 0;
    
    for (const op of operations) {
      const match = op.cell?.match(/^([A-Z]+)(\d+)$/i);
      if (match) {
        const colStr = match[1].toUpperCase();
        const rowNum = parseInt(match[2], 10) - 1;
        let colNum = 0;
        for (let i = 0; i < colStr.length; i++) {
          colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
        }
        colNum -= 1;
        maxRow = Math.max(maxRow, rowNum);
        maxCol = Math.max(maxCol, colNum);
        cells[op.cell] = { value: op.formula || op.value || '' };
      }
    }
    
    const sheetRows: any[] = [];
    for (let r = 0; r <= maxRow; r++) {
      const rowCells: any[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const cellAddr = `${getColumnLetter(c)}${r + 1}`;
        rowCells.push(cells[cellAddr] || {});
      }
      sheetRows.push({ cells: rowCells });
    }
    
    return [{
      name: 'Sheet1',
      rows: sheetRows,
      columns: Array(maxCol + 1).fill({ width: 120 })
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
  const [lastLoadTime, setLastLoadTime] = useState<number>(0);
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
    
    return '/workspace/spreadsheets/spreadsheet.json';
  }, [toolCall, toolResult]);

  const streamingSheets = useMemo(() => {
    if (!toolCall?.arguments) return null;
    return buildSheetsFromArguments(toolCall.arguments);
  }, [toolCall?.arguments]);

  useEffect(() => {
    if (isStreaming && streamingSheets) {
      setSheets(streamingSheets);
      setDataSource('streaming');
    }
  }, [isStreaming, streamingSheets]);

  const loadSpreadsheetData = useCallback(async () => {
    if (!sandboxId) {
      setIsLoading(false);
      return;
    }

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
      setLastLoadTime(Date.now());
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      const isNotFound = errorMsg.includes('not found') || 
                         errorMsg.includes('404') || 
                         errorMsg.includes('No such file') ||
                         errorMsg.includes('does not exist');
      if (!isNotFound) {
        console.warn('Spreadsheet load error:', errorMsg);
      }
    } finally {
      setIsLoading(false);
    }
  }, [sandboxId, filePath]);

  const prevIsStreamingRef = useRef(isStreaming);

  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    
    if (wasStreaming && !isStreaming && sandboxId) {
      const timer = setTimeout(() => {
        loadSpreadsheetData();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, sandboxId, loadSpreadsheetData]);

  useEffect(() => {
    if (!isStreaming && sandboxId && dataSource === 'streaming') {
      loadSpreadsheetData();
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!sandboxId || !ssRef.current) return;
    
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
        const cells: Record<string, any> = {};
        
        if (sheetModel?.rows) {
          sheetModel.rows.forEach((row: any, rowIdx: number) => {
            if (row?.cells) {
              row.cells.forEach((cell: any, colIdx: number) => {
                if (cell && (cell.value !== undefined || cell.formula)) {
                  const cellAddr = `${getColumnLetter(colIdx)}${rowIdx + 1}`;
                  cells[cellAddr] = {
                    value: cell.value,
                    formula: cell.formula,
                    style: cell.style
                  };
                }
              });
            }
          });
        }

        sheetsData.sheets.push({
          name: sheetModel?.name || `Sheet${sheetIdx + 1}`,
          cells,
          columns: {},
          rowCount: 100,
          colCount: 26
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
    const rowCount = sheets.reduce((acc, sheet) => acc + (sheet.rows?.length || 0), 0);
    const cellCount = sheets.reduce((acc, sheet) => {
      return acc + (sheet.rows?.reduce((racc: number, row: any) => racc + (row.cells?.length || 0), 0) || 0);
    }, 0);
    return `${sheets.length}-${rowCount}-${cellCount}-${lastLoadTime}`;
  }, [sheets, lastLoadTime]);

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
          cellEdit={handleCellEdit}
        />
      </CardContent>
    </Card>
  );
}
