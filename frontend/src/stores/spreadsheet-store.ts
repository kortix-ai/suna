import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// Type-only import to avoid bundling the 1-2 MB Syncfusion library
type SpreadsheetComponent = import('@syncfusion/ej2-react-spreadsheet').SpreadsheetComponent;

export interface SpreadsheetCell {
  value?: string;
  formula?: string;
  style?: {
    fontWeight?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface SpreadsheetRow {
  cells: SpreadsheetCell[];
}

export interface SpreadsheetSheet {
  name: string;
  rows: SpreadsheetRow[];
  columns?: { width: number }[];
  frozenRows?: number;
  frozenColumns?: number;
}

export interface SpreadsheetStreamOperation {
  type: string;
  action: string;
  sheet_index?: number;
  cell?: string;
  value?: string;
  formula?: string;
  style?: Record<string, any>;
  cells?: Array<{ cell: string; value?: string; formula?: string; style?: Record<string, any> }>;
  row_index?: number;
  is_header?: boolean;
  is_totals?: boolean;
  name?: string;
  columns?: Array<{ width: number }>;
  start_cell?: string;
  end_cell?: string;
  progress?: number;
  total?: number;
  total_rows?: number;
  total_columns?: number;
}

interface SpreadsheetState {
  sheets: SpreadsheetSheet[];
  spreadsheetRef: SpreadsheetComponent | null;
  isStreaming: boolean;
  streamProgress: { current: number; total: number } | null;
  
  setSpreadsheetRef: (ref: SpreadsheetComponent | null) => void;
  getSpreadsheetRef: () => SpreadsheetComponent | null;
  
  setSheets: (sheets: SpreadsheetSheet[]) => void;
  updateSheet: (sheetIndex: number, sheet: Partial<SpreadsheetSheet>) => void;
  updateCell: (sheetIndex: number, rowIndex: number, cellIndex: number, cell: Partial<SpreadsheetCell>) => void;
  addSheet: (sheet: SpreadsheetSheet) => void;
  removeSheet: (sheetIndex: number) => void;
  reset: () => void;
  
  updateCellValue: (cellAddress: string, value: string) => void;
  getCellValue: (cellAddress: string) => string | undefined;
  insertRow: (rowIndex?: number, count?: number) => void;
  insertColumn: (columnIndex?: number, count?: number) => void;
  deleteRow: (rowIndex?: number, count?: number) => void;
  deleteColumn: (columnIndex?: number, count?: number) => void;
  getData: (address?: string) => any;
  
  processStreamOperation: (operation: SpreadsheetStreamOperation) => void;
  setStreamProgress: (progress: { current: number; total: number } | null) => void;
  setIsStreaming: (isStreaming: boolean) => void;
}

function createEmptySheet(name: string = 'Sheet1'): SpreadsheetSheet {
  return {
    name,
    rows: [],
    columns: [
      { width: 120 }, { width: 120 }, { width: 120 }, { width: 120 },
      { width: 120 }, { width: 120 }, { width: 120 }, { width: 120 }
    ],
  };
}

const initialSheets: SpreadsheetSheet[] = [createEmptySheet()];

function parseCellAddress(cellAddress: string): { row: number; col: number } {
  const match = cellAddress.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return { row: 0, col: 0 };
  
  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10) - 1;
  
  let colNum = 0;
  for (let i = 0; i < colStr.length; i++) {
    colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
  }
  colNum -= 1;
  
  return { row: rowNum, col: colNum };
}

function ensureRowsExist(rows: SpreadsheetRow[], rowIndex: number): SpreadsheetRow[] {
  const newRows = [...rows];
  while (newRows.length <= rowIndex) {
    newRows.push({ cells: [] });
  }
  return newRows;
}

function ensureCellsExist(cells: SpreadsheetCell[], colIndex: number): SpreadsheetCell[] {
  const newCells = [...cells];
  while (newCells.length <= colIndex) {
    newCells.push({});
  }
  return newCells;
}

function updateCellInSheets(
  sheets: SpreadsheetSheet[],
  sheetIndex: number,
  cellAddress: string,
  cellData: Partial<SpreadsheetCell>
): SpreadsheetSheet[] {
  const { row, col } = parseCellAddress(cellAddress);
  const newSheets = [...sheets];
  
  while (newSheets.length <= sheetIndex) {
    newSheets.push(createEmptySheet(`Sheet${newSheets.length + 1}`));
  }
  
  const sheet = { ...newSheets[sheetIndex] };
  sheet.rows = ensureRowsExist(sheet.rows, row);
  
  const rowData = { ...sheet.rows[row] };
  rowData.cells = ensureCellsExist(rowData.cells, col);
  rowData.cells[col] = { ...rowData.cells[col], ...cellData };
  
  sheet.rows[row] = rowData;
  newSheets[sheetIndex] = sheet;
  
  return newSheets;
}

export const useSpreadsheetStore = create<SpreadsheetState>()(
  devtools(
    (set, get) => ({
      sheets: initialSheets,
      spreadsheetRef: null,
      isStreaming: false,
      streamProgress: null,
      
      setSpreadsheetRef: (ref: SpreadsheetComponent | null) => {
        set({ spreadsheetRef: ref });
      },
      
      getSpreadsheetRef: () => {
        return get().spreadsheetRef;
      },
      
      setIsStreaming: (isStreaming: boolean) => {
        set({ isStreaming });
      },
      
      setStreamProgress: (progress: { current: number; total: number } | null) => {
        set({ streamProgress: progress });
      },
      
      processStreamOperation: (operation: SpreadsheetStreamOperation) => {
        const { action, sheet_index = 0 } = operation;
        
        switch (action) {
          case 'start': {
            const shouldClear = (operation as any).clear_existing === true;
            
            if (shouldClear || get().sheets.length === 0 || (get().sheets[0].rows?.length === 0)) {
              const emptySheet = createEmptySheet('Sheet1');
              const numCols = operation.total_columns || 8;
              emptySheet.columns = [];
              for (let i = 0; i < numCols; i++) {
                emptySheet.columns.push({ width: 120 });
              }
              
              set({ 
                sheets: [emptySheet],
                isStreaming: true, 
                streamProgress: { current: 0, total: operation.total || 0 } 
              });
            } else {
              set({ 
                isStreaming: true, 
                streamProgress: { current: 0, total: operation.total || 0 } 
              });
            }
            break;
          }
            
          case 'update_cell': {
            if (operation.cell) {
              const cellData: Partial<SpreadsheetCell> = {};
              if (operation.value !== undefined) cellData.value = operation.value;
              if (operation.formula) cellData.formula = operation.formula;
              if (operation.style) cellData.style = operation.style;
              
              set((state) => ({
                sheets: updateCellInSheets(state.sheets, sheet_index, operation.cell!, cellData),
                streamProgress: operation.progress && operation.total 
                  ? { current: operation.progress, total: operation.total }
                  : state.streamProgress
              }));
            }
            break;
          }
            
          case 'update_row': {
            if (operation.cells) {
              set((state) => {
                let newSheets = state.sheets;
                for (const cellOp of operation.cells!) {
                  const cellData: Partial<SpreadsheetCell> = {};
                  if (cellOp.value !== undefined) cellData.value = cellOp.value;
                  if (cellOp.formula) cellData.formula = cellOp.formula;
                  if (cellOp.style) cellData.style = cellOp.style;
                  
                  newSheets = updateCellInSheets(newSheets, sheet_index, cellOp.cell, cellData);
                }
                
                return {
                  sheets: newSheets,
                  streamProgress: operation.progress && operation.total 
                    ? { current: operation.progress, total: operation.total }
                    : state.streamProgress
                };
              });
            }
            break;
          }
            
          case 'add_formula': {
            if (operation.cell && operation.formula) {
              const cellData: Partial<SpreadsheetCell> = { formula: operation.formula };
              if (operation.style) cellData.style = operation.style;
              set((state) => ({
                sheets: updateCellInSheets(state.sheets, sheet_index, operation.cell!, cellData)
              }));
            }
            break;
          }
          
          case 'format_range': {
            if ((operation as any).start_cell && (operation as any).end_cell && operation.style) {
              const startCell = (operation as any).start_cell as string;
              const endCell = (operation as any).end_cell as string;
              
              const startMatch = startCell.match(/^([A-Z]+)(\d+)$/i);
              const endMatch = endCell.match(/^([A-Z]+)(\d+)$/i);
              
              if (startMatch && endMatch) {
                const startCol = startMatch[1].toUpperCase().charCodeAt(0) - 65;
                const startRow = parseInt(startMatch[2], 10) - 1;
                const endCol = endMatch[1].toUpperCase().charCodeAt(0) - 65;
                const endRow = parseInt(endMatch[2], 10) - 1;
                
                set((state) => {
                  let newSheets = state.sheets;
                  for (let row = startRow; row <= endRow; row++) {
                    for (let col = startCol; col <= endCol; col++) {
                      const cellAddr = `${String.fromCharCode(65 + col)}${row + 1}`;
                      newSheets = updateCellInSheets(newSheets, sheet_index, cellAddr, { style: operation.style });
                    }
                  }
                  return { sheets: newSheets };
                });
              }
            }
            break;
          }
          
          case 'merge_cells': {
            const startCell = (operation as any).start_cell as string;
            const endCell = (operation as any).end_cell as string;
            const value = (operation as any).value;
            const style = operation.style || {};
            
            if (startCell) {
              const startMatch = startCell.match(/^([A-Z]+)(\d+)$/i);
              const endMatch = endCell?.match(/^([A-Z]+)(\d+)$/i);
              
              if (startMatch && endMatch) {
                const startCol = startMatch[1].toUpperCase().charCodeAt(0) - 65;
                const startRow = parseInt(startMatch[2], 10) - 1;
                const endCol = endMatch[1].toUpperCase().charCodeAt(0) - 65;
                const endRow = parseInt(endMatch[2], 10) - 1;
                
                const cellData: Partial<SpreadsheetCell> = {
                  style: {
                    ...style,
                    rowSpan: endRow - startRow + 1,
                    colSpan: endCol - startCol + 1,
                  }
                };
                if (value !== undefined) cellData.value = value;
                
                set((state) => ({
                  sheets: updateCellInSheets(state.sheets, sheet_index, startCell, cellData)
                }));
              }
            }
            break;
          }
          
          case 'set_column_width': {
            const columns = (operation as any).columns as Record<string, number>;
            if (columns) {
              set((state) => {
                const newSheets = [...state.sheets];
                if (sheet_index < newSheets.length) {
                  const sheet = { ...newSheets[sheet_index] };
                  const newColumns = [...(sheet.columns || [])];
                  
                  for (const [colLetter, width] of Object.entries(columns)) {
                    const colIndex = colLetter.toUpperCase().charCodeAt(0) - 65;
                    while (newColumns.length <= colIndex) {
                      newColumns.push({ width: 120 });
                    }
                    newColumns[colIndex] = { width };
                  }
                  
                  sheet.columns = newColumns;
                  newSheets[sheet_index] = sheet;
                }
                return { sheets: newSheets };
              });
            }
            break;
          }
            
          case 'create_sheet': {
            if (operation.name) {
              const newSheet = createEmptySheet(operation.name);
              if (operation.columns) {
                newSheet.columns = operation.columns;
              }
              set((state) => ({
                sheets: [...state.sheets, newSheet]
              }));
            }
            break;
          }
            
          case 'clear_range': {
            const startCell = (operation as any).start_cell;
            const endCell = (operation as any).end_cell;
            
            if (startCell && endCell) {
              const startMatch = startCell.match(/^([A-Z]+)(\d+)$/i);
              const endMatch = endCell.match(/^([A-Z]+)(\d+)$/i);
              
              if (startMatch && endMatch) {
                const startCol = startMatch[1].toUpperCase().charCodeAt(0) - 65;
                const startRow = parseInt(startMatch[2], 10) - 1;
                const endCol = endMatch[1].toUpperCase().charCodeAt(0) - 65;
                const endRow = parseInt(endMatch[2], 10) - 1;
                
                set((state) => {
                  let newSheets = state.sheets;
                  for (let row = startRow; row <= endRow; row++) {
                    for (let col = startCol; col <= endCol; col++) {
                      const cellAddr = `${String.fromCharCode(65 + col)}${row + 1}`;
                      newSheets = updateCellInSheets(newSheets, sheet_index, cellAddr, { value: '', formula: undefined });
                    }
                  }
                  return { sheets: newSheets };
                });
              }
            }
            break;
          }
            
          case 'complete': {
            set({ isStreaming: false, streamProgress: null });
            break;
          }
        }
      },
      
      setSheets: (sheets: SpreadsheetSheet[]) => {
        set({ sheets });
      },
      
      updateSheet: (sheetIndex: number, sheet: Partial<SpreadsheetSheet>) => {
        set((state) => {
          const newSheets = [...state.sheets];
          if (sheetIndex >= 0 && sheetIndex < newSheets.length) {
            newSheets[sheetIndex] = { ...newSheets[sheetIndex], ...sheet };
          }
          return { sheets: newSheets };
        });
      },
      
      updateCell: (sheetIndex: number, rowIndex: number, cellIndex: number, cell: Partial<SpreadsheetCell>) => {
        set((state) => {
          const newSheets = [...state.sheets];
          if (sheetIndex >= 0 && sheetIndex < newSheets.length) {
            const sheet = newSheets[sheetIndex];
            if (rowIndex >= 0 && rowIndex < sheet.rows.length) {
              const row = sheet.rows[rowIndex];
              if (cellIndex >= 0 && cellIndex < row.cells.length) {
                const newRows = [...sheet.rows];
                const newCells = [...row.cells];
                newCells[cellIndex] = { ...newCells[cellIndex], ...cell };
                newRows[rowIndex] = { cells: newCells };
                newSheets[sheetIndex] = { ...sheet, rows: newRows };
              }
            }
          }
          return { sheets: newSheets };
        });
      },
      
      addSheet: (sheet: SpreadsheetSheet) => {
        set((state) => ({
          sheets: [...state.sheets, sheet],
        }));
      },
      
      removeSheet: (sheetIndex: number) => {
        set((state) => ({
          sheets: state.sheets.filter((_, index) => index !== sheetIndex),
        }));
      },
      
      reset: () => {
        set({ sheets: initialSheets, spreadsheetRef: null, isStreaming: false, streamProgress: null });
      },
      
      updateCellValue: (cellAddress: string, value: string) => {
        const ref = get().spreadsheetRef;
        if (ref) {
          ref.updateCell({ value }, cellAddress);
        }
      },
      
      getCellValue: (cellAddress: string) => {
        const ref = get().spreadsheetRef;
        if (ref) {
          const data = ref.getData(cellAddress);
          return data?.[0]?.[0];
        }
        return undefined;
      },
      
      insertRow: (rowIndex?: number, count: number = 1) => {
        const ref = get().spreadsheetRef;
        if (ref) {
          ref.insertRow(rowIndex, count);
        }
      },
      
      insertColumn: (columnIndex?: number, count: number = 1) => {
        const ref = get().spreadsheetRef;
        if (ref) {
          ref.insertColumn(columnIndex, count);
        }
      },
      
      deleteRow: (rowIndex?: number, count: number = 1) => {
        const ref = get().spreadsheetRef;
        if (ref) {
          ref.delete(rowIndex, rowIndex ? rowIndex + count - 1 : undefined, 'Row');
        }
      },
      
      deleteColumn: (columnIndex?: number, count: number = 1) => {
        const ref = get().spreadsheetRef;
        if (ref) {
          ref.delete(columnIndex, columnIndex ? columnIndex + count - 1 : undefined, 'Column');
        }
      },
      
      getData: (address?: string) => {
        const ref = get().spreadsheetRef;
        if (ref) {
          return ref.getData(address);
        }
        return null;
      },
    }),
    {
      name: 'spreadsheet-store',
    }
  )
);

export const useSpreadsheetSheets = () => 
  useSpreadsheetStore((state) => state.sheets);

export const useSpreadsheetRef = () => 
  useSpreadsheetStore((state) => state.spreadsheetRef);

export const useSetSpreadsheetRef = () =>
  useSpreadsheetStore((state) => state.setSpreadsheetRef);

export const useGetSpreadsheetRef = () =>
  useSpreadsheetStore((state) => state.getSpreadsheetRef);

export const useSetSheets = () =>
  useSpreadsheetStore((state) => state.setSheets);

export const useUpdateSheet = () =>
  useSpreadsheetStore((state) => state.updateSheet);

export const useUpdateCell = () =>
  useSpreadsheetStore((state) => state.updateCell);

export const useAddSheet = () =>
  useSpreadsheetStore((state) => state.addSheet);

export const useRemoveSheet = () =>
  useSpreadsheetStore((state) => state.removeSheet);

export const useResetSpreadsheet = () =>
  useSpreadsheetStore((state) => state.reset);

export const useUpdateCellValue = () =>
  useSpreadsheetStore((state) => state.updateCellValue);

export const useGetCellValue = () =>
  useSpreadsheetStore((state) => state.getCellValue);

export const useInsertRow = () =>
  useSpreadsheetStore((state) => state.insertRow);

export const useInsertColumn = () =>
  useSpreadsheetStore((state) => state.insertColumn);

export const useDeleteRow = () =>
  useSpreadsheetStore((state) => state.deleteRow);

export const useDeleteColumn = () =>
  useSpreadsheetStore((state) => state.deleteColumn);

export const useGetData = () =>
  useSpreadsheetStore((state) => state.getData);

export const useSpreadsheetIsStreaming = () =>
  useSpreadsheetStore((state) => state.isStreaming);

export const useSpreadsheetStreamProgress = () =>
  useSpreadsheetStore((state) => state.streamProgress);

export const useProcessStreamOperation = () =>
  useSpreadsheetStore((state) => state.processStreamOperation);

export const useSetIsStreaming = () =>
  useSpreadsheetStore((state) => state.setIsStreaming);

export const useSetStreamProgress = () =>
  useSpreadsheetStore((state) => state.setStreamProgress);
