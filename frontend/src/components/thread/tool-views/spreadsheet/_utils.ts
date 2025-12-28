import { ToolCallData, ToolResultData } from '../types';

type ToolCall = ToolCallData | { name?: string; arguments?: Record<string, any>; metadata?: any };
type ToolResult = ToolResultData | { output?: any; success?: boolean } | null;

export interface SpreadsheetCellData {
  value?: string;
  formula?: string;
  style?: Record<string, any>;
}

export interface SpreadsheetRowData {
  cells: SpreadsheetCellData[];
}

export interface ExtractedSpreadsheetData {
  headers: string[];
  rows: string[][];
  sheetIndex: number;
  startCell: string;
  includeTotals: boolean;
  message: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
  operations: Array<{
    cell: string;
    value?: string;
    formula?: string;
    style?: Record<string, any>;
  }>;
}

export function extractSpreadsheetData(
  toolCall: ToolCall,
  toolResult: ToolResult | null,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ExtractedSpreadsheetData {
  const defaultData: ExtractedSpreadsheetData = {
    headers: [],
    rows: [],
    sheetIndex: 0,
    startCell: 'A1',
    includeTotals: false,
    message: null,
    actualIsSuccess: false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    operations: [],
  };

  if (!toolCall) {
    return defaultData;
  }

  const args = toolCall.arguments || {};
  
  let headers = args.headers || [];
  let rows = args.rows || [];
  let sheetIndex = args.sheet_index || 0;
  let startCell = args.start_cell || 'A1';
  let includeTotals = args.include_totals || false;
  let operations = args.operations || [];

  let parsedResult: any = null;
  if (toolResult?.output) {
    try {
      if (typeof toolResult.output === 'string') {
        parsedResult = JSON.parse(toolResult.output);
      } else {
        parsedResult = toolResult.output;
      }
    } catch (e) {
      console.warn('Failed to parse spreadsheet tool result:', e);
    }
  }

  const actualIsSuccess = toolResult?.success ?? isSuccess;
  const message = parsedResult?.message || null;

  if (parsedResult) {
    headers = parsedResult.headers || headers;
    rows = parsedResult.rows || rows;
    sheetIndex = parsedResult.sheet_index ?? sheetIndex;
  }

  return {
    headers,
    rows,
    sheetIndex,
    startCell,
    includeTotals,
    message,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    operations,
  };
}

export function buildSheetsFromData(data: ExtractedSpreadsheetData): any[] {
  if (data.headers.length === 0 && data.rows.length === 0 && data.operations.length === 0) {
    return [{
      name: 'Sheet1',
      rows: [],
      columns: [
        { width: 120 }, { width: 120 }, { width: 120 }, { width: 120 },
        { width: 120 }, { width: 120 }, { width: 120 }, { width: 120 }
      ],
    }];
  }

  const rows: any[] = [];

  if (data.headers.length > 0) {
    rows.push({
      cells: data.headers.map(h => ({ value: h, style: { fontWeight: 'bold' } }))
    });
  }

  for (const row of data.rows) {
    rows.push({
      cells: row.map(cell => ({ value: String(cell) }))
    });
  }

  const columns = data.headers.map(() => ({ width: 120 }));
  if (columns.length === 0) {
    for (let i = 0; i < 8; i++) columns.push({ width: 120 });
  }

  return [{
    name: 'Sheet1',
    rows,
    columns,
    frozenRows: data.headers.length > 0 ? 1 : 0,
  }];
}

