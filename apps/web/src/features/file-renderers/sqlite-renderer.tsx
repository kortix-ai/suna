'use client';

import { useTranslations } from 'next-intl';

/**
 * SqliteRenderer — Full-featured SQLite database viewer & editor.
 *
 * Architecture:
 *   1. Load .db/.sqlite/.sqlite3 file as ArrayBuffer via readFileAsBlob
 *   2. Initialize sql.js (WASM) and open the database in-memory
 *   3. Extract all tables, views, and indexes from sqlite_master
 *   4. Features:
 *      - Table/view sidebar with row counts
 *      - AG Grid data viewer with sorting, filtering, search
 *      - Inline cell editing (double-click) → runs UPDATE statements
 *      - Add row / delete row support
 *      - Save modified database back to file
 *      - Schema inspector (CREATE TABLE statements, column info)
 *      - Raw SQL query executor with results grid
 *   5. Lazy-loaded — only pulled in when a .db file is opened
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  CalendarIcon as Calendar,
  CheckIcon as Check,
  CodeSimpleIcon as Code2,
  CopyIcon as Copy,
  DatabaseIcon as Database,
  DownloadIcon as Download,
  EyeIcon as Eye,
  FileMagnifyingGlassIcon as FileQuestion,
  HashIcon as Hash,
  KeyIcon as Key,
  ListIcon as List,
  CircleNotchIcon as Loader2,
  PlayIcon as Play,
  PlusIcon as Plus,
  ArrowsClockwiseIcon as RefreshCw,
  FloppyDiskIcon as Save,
  MagnifyingGlassIcon as Search,
  TableIcon as Table2,
  ToggleLeftIcon as ToggleLeft,
  TrashIcon as Trash2,
  TextTIcon as Type,
  ArrowUUpLeftIcon as Undo2,
  XIcon as X,
} from '@phosphor-icons/react';
import {
  AllCommunityModule,
  colorSchemeDarkBlue,
  colorSchemeLight,
  ModuleRegistry,
  themeQuartz,
  type CellDoubleClickedEvent,
  type CellValueChangedEvent,
  type ColDef,
  type FirstDataRenderedEvent,
  type RowSelectionOptions,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useTheme } from 'next-themes';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Register AG Grid modules once
ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid theme
const gridTheme = themeQuartz.withParams({
  spacing: 6,
  headerFontSize: 12,
  fontSize: 12,
  rowHeight: 36,
  headerHeight: 38,
  wrapperBorderRadius: 0,
  borderRadius: 0,
  cellHorizontalPaddingScale: 1,
});

// Lazy DataGrid only for query results (read-only, no special wiring needed)
const DataGrid = lazy(() =>
  import('@/components/ui/data-grid').then((m) => ({ default: m.DataGrid })),
);

function GridFallback() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="text-muted-foreground animate-pulse text-sm">
        {tHardcodedUi.raw('componentsFileRenderersSqliteRenderer.line97JsxTextLoadingGrid')}
      </div>
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────────────────

interface SqliteRendererProps {
  filePath: string;
  fileName: string;
  className?: string;
  readOnly?: boolean;
}

interface TableInfo {
  name: string;
  type: 'table' | 'view';
  sql: string;
  rowCount: number;
  columns: ColumnInfo[];
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  time: number;
  error?: string;
}

type ViewMode = 'data' | 'schema' | 'query';

// ── SQL type → icon mapping ─────────────────────────────────────────────

function getTypeIcon(sqlType: string) {
  const t = sqlType.toUpperCase();
  if (
    t.includes('INT') ||
    t.includes('REAL') ||
    t.includes('FLOAT') ||
    t.includes('DOUBLE') ||
    t.includes('NUMERIC') ||
    t.includes('DECIMAL')
  )
    return <Hash className="h-3 w-3 text-cyan-500/70" />;
  if (
    t.includes('TEXT') ||
    t.includes('CHAR') ||
    t.includes('CLOB') ||
    t.includes('VARCHAR') ||
    t.includes('STRING')
  )
    return <Type className="h-3 w-3 text-emerald-500/70" />;
  if (t.includes('BOOL')) return <ToggleLeft className="h-3 w-3 text-yellow-500/70" />;
  if (t.includes('DATE') || t.includes('TIME') || t.includes('TIMESTAMP'))
    return <Calendar className="h-3 w-3 text-purple-500/70" />;
  if (t.includes('BLOB') || t.includes('BINARY'))
    return <Database className="h-3 w-3 text-orange-500/70" />;
  return <FileQuestion className="text-muted-foreground/50 h-3 w-3" />;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Escape a value for a SQL literal. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// ── Component ────────────────────────────────────────────────────────────

export function SqliteRenderer({
  filePath,
  fileName,
  className,
  readOnly = false,
}: SqliteRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // State
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('data');
  const [searchTerm, setSearchTerm] = useState('');
  const [tableSearch, setTableSearch] = useState('');
  const [sqlQuery, setSqlQuery] = useState('');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [isQueryRunning, setIsQueryRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [expandedCell, setExpandedCell] = useState<{
    column: string;
    value: string;
    rowIndex: number;
  } | null>(null);
  const [expandedEditValue, setExpandedEditValue] = useState('');

  // Refs
  const dbRef = useRef<InstanceType<typeof import('sql.js').Database> | null>(null);
  const gridApiRef = useRef<AgGridReact | null>(null);

  // AG Grid theme
  const { resolvedTheme } = useTheme();
  const agTheme = useMemo(() => {
    const colorScheme = resolvedTheme === 'dark' ? colorSchemeDarkBlue : colorSchemeLight;
    return gridTheme.withPart(colorScheme);
  }, [resolvedTheme]);

  // ── Refresh table metadata after mutations ────────────────────────────
  const refreshTableMeta = useCallback(() => {
    const db = dbRef.current;
    if (!db) return;

    try {
      const masterQuery = db.exec(
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      );

      const tableInfos: TableInfo[] = [];
      if (masterQuery.length > 0) {
        for (const row of masterQuery[0].values) {
          const name = String(row[0]);
          const type = String(row[1]) as 'table' | 'view';
          const sql = String(row[2] || '');

          let rowCount = 0;
          try {
            const countResult = db.exec(`SELECT COUNT(*) FROM ${quoteIdent(name)}`);
            if (countResult.length > 0) rowCount = Number(countResult[0].values[0][0]);
          } catch {
            /* ignore */
          }

          const columns: ColumnInfo[] = [];
          try {
            const pragmaResult = db.exec(`PRAGMA table_info(${quoteIdent(name)})`);
            if (pragmaResult.length > 0) {
              for (const col of pragmaResult[0].values) {
                columns.push({
                  cid: Number(col[0]),
                  name: String(col[1]),
                  type: String(col[2] || 'TEXT'),
                  notnull: Boolean(col[3]),
                  dflt_value: col[4] != null ? String(col[4]) : null,
                  pk: Boolean(col[5]),
                });
              }
            }
          } catch {
            /* ignore */
          }

          tableInfos.push({ name, type, sql, rowCount, columns });
        }
      }
      setTables(tableInfos);
    } catch {
      /* ignore */
    }
  }, []);

  // ── Initialize database ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setIsLoading(true);
      setError(null);

      try {
        const { readFileAsBlob } = await import('@/features/files/api/opencode-files');
        const blob = await readFileAsBlob(filePath);
        const arrayBuffer = await blob.arrayBuffer();

        if (cancelled) return;
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error('Empty database file');
        }

        const initSqlJs = (await import('sql.js')).default;
        const SQL = await initSqlJs({
          locateFile: () => '/sql-wasm.wasm',
        });

        if (cancelled) return;

        const db = new SQL.Database(new Uint8Array(arrayBuffer));
        dbRef.current = db;

        // Extract tables and views
        const masterQuery = db.exec(
          "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        );

        if (cancelled) return;

        const tableInfos: TableInfo[] = [];
        if (masterQuery.length > 0) {
          for (const row of masterQuery[0].values) {
            const name = String(row[0]);
            const type = String(row[1]) as 'table' | 'view';
            const sql = String(row[2] || '');

            let rowCount = 0;
            try {
              const countResult = db.exec(`SELECT COUNT(*) FROM ${quoteIdent(name)}`);
              if (countResult.length > 0) rowCount = Number(countResult[0].values[0][0]);
            } catch {
              /* ignore */
            }

            const columns: ColumnInfo[] = [];
            try {
              const pragmaResult = db.exec(`PRAGMA table_info(${quoteIdent(name)})`);
              if (pragmaResult.length > 0) {
                for (const col of pragmaResult[0].values) {
                  columns.push({
                    cid: Number(col[0]),
                    name: String(col[1]),
                    type: String(col[2] || 'TEXT'),
                    notnull: Boolean(col[3]),
                    dflt_value: col[4] != null ? String(col[4]) : null,
                    pk: Boolean(col[5]),
                  });
                }
              }
            } catch {
              /* ignore */
            }

            tableInfos.push({ name, type, sql, rowCount, columns });
          }
        }

        if (cancelled) return;

        setTables(tableInfos);
        if (tableInfos.length > 0) {
          setSelectedTable(tableInfos[0].name);
        }
        setIsLoading(false);
      } catch (e: unknown) {
        console.error('[SqliteRenderer] Error:', e);
        if (!cancelled) {
          setError((e as Error)?.message || 'Failed to load database');
          setIsLoading(false);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      if (dbRef.current) {
        try {
          dbRef.current.close();
        } catch {
          /* ignore */
        }
        dbRef.current = null;
      }
    };
  }, [filePath]);

  // ── Get table data ────────────────────────────────────────────────────
  const tableData = useMemo((): { columns: string[]; rows: Record<string, unknown>[] } => {
    if (!dbRef.current || !selectedTable) return { columns: [], rows: [] };

    try {
      const result = dbRef.current.exec(`SELECT * FROM ${quoteIdent(selectedTable)} LIMIT 10000`);
      if (result.length === 0) return { columns: [], rows: [] };

      const columns: string[] = result[0].columns;
      const rows = result[0].values.map((row: unknown[]) => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col: string, i: number) => {
          const val = row[i];
          if (val instanceof Uint8Array) {
            obj[col] = `[BLOB ${val.length} bytes]`;
          } else {
            obj[col] = val;
          }
        });
        return obj;
      });

      return { columns, rows };
    } catch {
      return { columns: [], rows: [] };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTable, tables, dataVersion]);

  // ── Selected table info ───────────────────────────────────────────────
  const selectedTableInfo = useMemo(
    () => tables.find((t) => t.name === selectedTable) ?? null,
    [tables, selectedTable],
  );

  // ── Column defs for AG Grid (editable for tables, not views) ──────────
  const isEditable = !readOnly && selectedTableInfo?.type === 'table';
  const columnDefs = useMemo((): ColDef[] => {
    if (!tableData.columns.length) return [];
    const pkColumns = new Set(
      selectedTableInfo?.columns.filter((c) => c.pk).map((c) => c.name) ?? [],
    );

    return tableData.columns.map((col) => ({
      field: col,
      headerName: col,
      minWidth: 100,
      editable: isEditable,
      flex: tableData.columns.length <= 8 ? 1 : undefined,
      width: tableData.columns.length > 8 ? 160 : undefined,
      headerClass: pkColumns.has(col) ? 'font-semibold' : '',
      cellStyle: { cursor: isEditable ? 'text' : 'default' },
    }));
  }, [tableData.columns, selectedTableInfo, isEditable]);

  // ── Handle cell edit → run UPDATE ─────────────────────────────────────
  const handleCellValueChanged = useCallback(
    (event: CellValueChangedEvent) => {
      const db = dbRef.current;
      if (readOnly || !db || !selectedTable || !selectedTableInfo) return;

      const colName = event.colDef.field;
      const newValue = event.newValue;
      const oldValue = event.oldValue;
      if (!colName || newValue === oldValue) return;

      // Build WHERE clause from PK columns (or all columns as fallback)
      const pkCols = selectedTableInfo.columns.filter((c) => c.pk);
      const whereCols = pkCols.length > 0 ? pkCols : selectedTableInfo.columns;

      const whereClause = whereCols
        .map((c) => {
          const val = event.data[c.name];
          // For the column being edited, use old value in WHERE
          if (c.name === colName) {
            return `${quoteIdent(c.name)} IS ${sqlLiteral(oldValue)}`;
          }
          return `${quoteIdent(c.name)} IS ${sqlLiteral(val)}`;
        })
        .join(' AND ');

      const sql = `UPDATE ${quoteIdent(selectedTable)} SET ${quoteIdent(colName)} = ${sqlLiteral(newValue)} WHERE ${whereClause}`;

      try {
        db.exec(sql);
        setHasUnsavedChanges(true);
        refreshTableMeta();
      } catch (e: unknown) {
        toast.error(`Update failed: ${(e as Error)?.message || 'Unknown error'}`);
        // Revert the cell
        event.node.setDataValue(colName, oldValue);
      }
    },
    [selectedTable, selectedTableInfo, refreshTableMeta, readOnly],
  );

  // ── Cell double-click → expand long values ────────────────────────────
  const handleCellDoubleClicked = useCallback(
    (event: CellDoubleClickedEvent) => {
      const value = event.value;
      const colName = event.colDef.field;
      if (!colName) return;

      const strVal = value == null ? '' : String(value);
      // Only expand if value is long or if it's a non-editable view
      if (strVal.length > 80 || !isEditable) {
        // Stop AG Grid's default inline editing for this cell
        event.api.stopEditing(true);
        setExpandedCell({
          column: colName,
          value: strVal,
          rowIndex: event.rowIndex ?? 0,
        });
        setExpandedEditValue(strVal);
      }
      // Short values on editable tables → let AG Grid handle inline editing normally
    },
    [isEditable],
  );

  // ── Save expanded cell edit ───────────────────────────────────────────
  const handleExpandedSave = useCallback(() => {
    const db = dbRef.current;
    if (readOnly || !db || !selectedTable || !selectedTableInfo || !expandedCell) return;

    const newValue = expandedEditValue;
    const colName = expandedCell.column;

    // Get the row data from the grid
    const api = gridApiRef.current?.api;
    if (!api) return;
    const rowNode = api.getDisplayedRowAtIndex(expandedCell.rowIndex);
    if (!rowNode || !rowNode.data) return;

    const pkCols = selectedTableInfo.columns.filter((c) => c.pk);
    const whereCols = pkCols.length > 0 ? pkCols : selectedTableInfo.columns;

    const whereClause = whereCols
      .map((c) => `${quoteIdent(c.name)} IS ${sqlLiteral(rowNode.data[c.name])}`)
      .join(' AND ');

    const sql = `UPDATE ${quoteIdent(selectedTable)} SET ${quoteIdent(colName)} = ${sqlLiteral(newValue)} WHERE ${whereClause}`;

    try {
      db.exec(sql);
      setHasUnsavedChanges(true);
      setDataVersion((v) => v + 1);
      refreshTableMeta();
      setExpandedCell(null);
      toast.success('Cell updated');
    } catch (e: unknown) {
      toast.error(`Update failed: ${(e as Error)?.message || 'Unknown error'}`);
    }
  }, [
    selectedTable,
    selectedTableInfo,
    expandedCell,
    expandedEditValue,
    refreshTableMeta,
    readOnly,
  ]);

  // ── Row selection config ──────────────────────────────────────────────
  const rowSelection = useMemo(
    (): RowSelectionOptions => ({
      mode: 'multiRow',
      checkboxes: isEditable,
      headerCheckbox: isEditable,
    }),
    [isEditable],
  );

  // ── Add new row ───────────────────────────────────────────────────────
  const handleAddRow = useCallback(() => {
    const db = dbRef.current;
    if (readOnly || !db || !selectedTable || !selectedTableInfo) return;

    // Build INSERT with default values
    const cols = selectedTableInfo.columns;
    const colNames = cols.map((c) => quoteIdent(c.name)).join(', ');
    const values = cols
      .map((c) => {
        if (c.dflt_value != null) return c.dflt_value;
        if (c.pk) return 'NULL'; // autoincrement
        if (c.notnull) {
          const t = c.type.toUpperCase();
          if (
            t.includes('INT') ||
            t.includes('REAL') ||
            t.includes('FLOAT') ||
            t.includes('NUMERIC')
          )
            return '0';
          if (t.includes('BOOL')) return '0';
          return "''";
        }
        return 'NULL';
      })
      .join(', ');

    const sql = `INSERT INTO ${quoteIdent(selectedTable)} (${colNames}) VALUES (${values})`;
    try {
      db.exec(sql);
      setHasUnsavedChanges(true);
      setDataVersion((v) => v + 1);
      refreshTableMeta();
      toast.success('Row added');
    } catch (e: unknown) {
      toast.error(`Insert failed: ${(e as Error)?.message || 'Unknown error'}`);
    }
  }, [selectedTable, selectedTableInfo, refreshTableMeta, readOnly]);

  // ── Delete selected rows ──────────────────────────────────────────────
  const handleDeleteSelected = useCallback(() => {
    const db = dbRef.current;
    const api = gridApiRef.current?.api;
    if (readOnly || !db || !api || !selectedTable || !selectedTableInfo) return;

    const selectedRows = api.getSelectedRows();
    if (selectedRows.length === 0) {
      toast.error('No rows selected — click a row first');
      return;
    }

    const pkCols = selectedTableInfo.columns.filter((c) => c.pk);
    const whereCols = pkCols.length > 0 ? pkCols : selectedTableInfo.columns;

    let deleted = 0;
    for (const row of selectedRows) {
      const whereClause = whereCols
        .map((c) => `${quoteIdent(c.name)} IS ${sqlLiteral(row[c.name])}`)
        .join(' AND ');

      try {
        db.exec(`DELETE FROM ${quoteIdent(selectedTable)} WHERE ${whereClause} LIMIT 1`);
        deleted++;
      } catch {
        /* skip */
      }
    }

    if (deleted > 0) {
      setHasUnsavedChanges(true);
      setDataVersion((v) => v + 1);
      refreshTableMeta();
      toast.success(`${deleted} row${deleted !== 1 ? 's' : ''} deleted`);
    }
  }, [selectedTable, selectedTableInfo, refreshTableMeta, readOnly]);

  // ── Save database back to file ────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const db = dbRef.current;
    if (readOnly || !db) return;

    setIsSaving(true);
    try {
      const data = db.export();
      const blob = new Blob([data as unknown as BlobPart], { type: 'application/x-sqlite3' });
      const file = new File([blob], fileName, { type: 'application/x-sqlite3' });
      const parentPath = filePath.substring(0, filePath.lastIndexOf('/'));
      const { uploadFile } = await import('@/features/files/api/opencode-files');
      await uploadFile(file, parentPath || undefined);
      setHasUnsavedChanges(false);
      toast.success('Database saved');
    } catch (e: unknown) {
      toast.error(`Save failed: ${(e as Error)?.message || 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  }, [filePath, fileName, readOnly]);

  // ── Discard changes (reload from disk) ────────────────────────────────
  const handleDiscard = useCallback(() => {
    if (dbRef.current) {
      try {
        dbRef.current.close();
      } catch {
        /* ignore */
      }
      dbRef.current = null;
    }
    setHasUnsavedChanges(false);
    setDataVersion(0);
    setTables([]);
    setSelectedTable(null);
    setIsLoading(true);
    setError(null);
    // Re-trigger the init effect by forcing a state change
    // (The effect depends on filePath which hasn't changed,
    //  so we use a key trick — but since we can't change key from inside,
    //  we just re-run init inline)
    (async () => {
      try {
        const { readFileAsBlob } = await import('@/features/files/api/opencode-files');
        const blob = await readFileAsBlob(filePath);
        const arrayBuffer = await blob.arrayBuffer();
        if (!arrayBuffer.byteLength) throw new Error('Empty file');

        const initSqlJs = (await import('sql.js')).default;
        const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
        const db = new SQL.Database(new Uint8Array(arrayBuffer));
        dbRef.current = db;
        refreshTableMeta();

        const firstTable = tables[0]?.name;
        if (firstTable) setSelectedTable(firstTable);
        setDataVersion((v) => v + 1);
        setIsLoading(false);
        toast.success('Changes discarded');
      } catch (e: unknown) {
        setError((e as Error)?.message || 'Reload failed');
        setIsLoading(false);
      }
    })();
  }, [filePath, refreshTableMeta, tables]);

  // ── Filtered tables ───────────────────────────────────────────────────
  const filteredTables = useMemo(() => {
    if (!tableSearch.trim()) return tables;
    const q = tableSearch.toLowerCase();
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableSearch]);

  // ── Run SQL query ─────────────────────────────────────────────────────
  const runQuery = useCallback(() => {
    if (!dbRef.current || !sqlQuery.trim()) return;

    setIsQueryRunning(true);
    const start = performance.now();

    try {
      const result = dbRef.current.exec(sqlQuery.trim());
      const elapsed = performance.now() - start;

      // Detect mutation queries → mark dirty + refresh
      const upper = sqlQuery.trim().toUpperCase();
      const isMutation =
        upper.startsWith('INSERT') ||
        upper.startsWith('UPDATE') ||
        upper.startsWith('DELETE') ||
        upper.startsWith('DROP') ||
        upper.startsWith('ALTER') ||
        upper.startsWith('CREATE');
      if (readOnly && isMutation) {
        throw new Error('Database is open read-only');
      }
      if (isMutation) {
        setHasUnsavedChanges(true);
        setDataVersion((v) => v + 1);
        refreshTableMeta();
      }

      if (result.length === 0) {
        setQueryResult({ columns: [], rows: [], rowCount: 0, time: elapsed });
      } else {
        const columns: string[] = result[0].columns;
        const rows = result[0].values.map((row: unknown[]) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((col: string, i: number) => {
            const val = row[i];
            if (val instanceof Uint8Array) {
              obj[col] = `[BLOB ${val.length} bytes]`;
            } else {
              obj[col] = val;
            }
          });
          return obj;
        });
        setQueryResult({ columns, rows, rowCount: rows.length, time: elapsed });
      }
    } catch (e: unknown) {
      const elapsed = performance.now() - start;
      setQueryResult({
        columns: [],
        rows: [],
        rowCount: 0,
        time: elapsed,
        error: (e as Error)?.message || 'Query failed',
      });
    } finally {
      setIsQueryRunning(false);
    }
  }, [sqlQuery, refreshTableMeta, readOnly]);

  // ── Keyboard shortcut: Cmd+Enter to run query ─────────────────────────
  const handleQueryKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runQuery();
      }
    },
    [runQuery],
  );

  // ── Cmd+S to save ─────────────────────────────────────────────────────
  useEffect(() => {
    if (readOnly || !hasUnsavedChanges) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hasUnsavedChanges, handleSave, readOnly]);

  // ── Copy SQL ──────────────────────────────────────────────────────────
  const handleCopySchema = useCallback(() => {
    if (!selectedTableInfo?.sql) return;
    navigator.clipboard.writeText(selectedTableInfo.sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [selectedTableInfo]);

  // ── Export table as CSV ───────────────────────────────────────────────
  const handleExportCsv = useCallback(() => {
    gridApiRef.current?.api?.exportDataAsCsv({ fileName: `${selectedTable || 'export'}.csv` });
  }, [selectedTable]);

  // ── Loading state ─────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="text-muted-foreground/40 h-6 w-6 animate-spin" />
          <span className="text-muted-foreground/60 text-sm">
            {tHardcodedUi.raw(
              'componentsFileRenderersSqliteRenderer.line733JsxTextLoadingDatabase',
            )}
          </span>
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────
  if (error) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="space-y-3 text-center">
          <div className="bg-muted mx-auto flex h-16 w-16 items-center justify-center rounded-full">
            <Database className="text-muted-foreground h-8 w-8" />
          </div>
          <div>
            <h3 className="text-foreground text-lg font-medium">
              {tHardcodedUi.raw(
                'componentsFileRenderersSqliteRenderer.line748JsxTextFailedToLoadDatabase',
              )}
            </h3>
            <p className="text-muted-foreground mt-1 max-w-sm text-xs">{error}</p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-2xl border px-3 text-xs transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Empty database ────────────────────────────────────────────────────
  if (tables.length === 0) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="space-y-3 text-center">
          <div className="bg-muted mx-auto flex h-16 w-16 items-center justify-center rounded-full">
            <Database className="text-muted-foreground h-8 w-8" />
          </div>
          <div>
            <h3 className="text-foreground text-lg font-medium">
              {tHardcodedUi.raw(
                'componentsFileRenderersSqliteRenderer.line772JsxTextEmptyDatabase',
              )}
            </h3>
            <p className="text-muted-foreground text-sm">
              {tHardcodedUi.raw(
                'componentsFileRenderersSqliteRenderer.line773JsxTextNoTablesOrViewsFoundInThisDatabase',
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Main layout ───────────────────────────────────────────────────────
  return (
    <div className={cn('bg-background relative flex h-full w-full flex-col', className)}>
      {/* ── Top toolbar ──────────────────────────────────────────────── */}
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b px-3 py-1.5">
        {/* Left: summary (no filename — parent header already shows it) */}
        <span className="text-muted-foreground/60 text-xs tabular-nums">
          {tables.filter((t) => t.type === 'table').length} table
          {tables.filter((t) => t.type === 'table').length !== 1 ? 's' : ''}
          {tables.some((t) => t.type === 'view') && (
            <>
              {' '}
              · {tables.filter((t) => t.type === 'view').length} view
              {tables.filter((t) => t.type === 'view').length !== 1 ? 's' : ''}
            </>
          )}
          <> · {tables.reduce((sum, t) => sum + t.rowCount, 0).toLocaleString()} rows</>
        </span>

        {hasUnsavedChanges && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-yellow-500"
            title={tHardcodedUi.raw(
              'componentsFileRenderersSqliteRenderer.line795JsxAttrTitleUnsavedChanges',
            )}
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Save / Discard */}
          {hasUnsavedChanges && (
            <>
              <Button
                variant="muted"
                size="toolbar"
                onClick={handleDiscard}
                title={tHardcodedUi.raw(
                  'componentsFileRenderersSqliteRenderer.line806JsxAttrTitleDiscardChanges',
                )}
              >
                <Undo2 className="h-3 w-3" />
                Discard
              </Button>
              <Button
                variant="default"
                size="toolbar"
                onClick={handleSave}
                disabled={isSaving}
                title={tHardcodedUi.raw(
                  'componentsFileRenderersSqliteRenderer.line816JsxAttrTitleSaveToFileS',
                )}
              >
                {isSaving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                Save
              </Button>
            </>
          )}

          {/* View mode toggle */}
          <div className="bg-muted/60 ml-1 flex items-center rounded-md p-0.5">
            {(['data', 'schema', 'query'] as const).map((mode) => (
              <button
                key={mode}
                className={cn(
                  'inline-flex h-6 cursor-pointer items-center gap-1 rounded-sm px-2 text-xs transition-colors',
                  viewMode === mode
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
                onClick={() => setViewMode(mode)}
              >
                {mode === 'data' && <List className="h-3 w-3" />}
                {mode === 'schema' && <Code2 className="h-3 w-3" />}
                {mode === 'query' && <Play className="h-3 w-3" />}
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Content area ─────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar: table list ───────────────────────────────────── */}
        <div className="bg-muted/10 flex w-56 flex-shrink-0 flex-col border-r">
          {/* Table search */}
          <div className="border-b p-2">
            <div className="relative">
              <Search className="text-muted-foreground/50 absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2" />
              <Input
                type="text"
                placeholder={tHardcodedUi.raw(
                  'componentsFileRenderersSqliteRenderer.line860JsxAttrPlaceholderFilterTables',
                )}
                autoComplete="off"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                className="h-7 pr-7 pl-7 text-xs"
              />
              {tableSearch && (
                <button
                  onClick={() => setTableSearch('')}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* Table list */}
          <div className="flex-1 overflow-y-auto py-1">
            {filteredTables.map((table) => (
              <button
                key={table.name}
                onClick={() => {
                  setSelectedTable(table.name);
                  setSearchTerm('');
                  if (viewMode === 'query') {
                    setSqlQuery(`SELECT * FROM ${quoteIdent(table.name)} LIMIT 100`);
                  }
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
                  selectedTable === table.name
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                {table.type === 'view' ? (
                  <Eye className="h-3.5 w-3.5 flex-shrink-0 text-purple-500/70" />
                ) : (
                  <Table2 className="h-3.5 w-3.5 flex-shrink-0 text-blue-500/70" />
                )}
                <span className="flex-1 truncate text-xs font-medium">{table.name}</span>
                <span className="text-muted-foreground/50 flex-shrink-0 text-xs tabular-nums">
                  {table.rowCount.toLocaleString()}
                </span>
              </button>
            ))}
          </div>

          {/* Sidebar footer */}
          <div className="text-muted-foreground/30 border-t px-3 py-1.5 text-xs tabular-nums">
            {filteredTables.length}/{tables.length} shown
          </div>
        </div>

        {/* ── Main panel ─────────────────────────────────────────────── */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* ── DATA VIEW ─────────────────────────────────────────── */}
          {viewMode === 'data' && selectedTableInfo && (
            <>
              {/* Data toolbar */}
              <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b px-3 py-1.5">
                {/* Table name + stats */}
                <div className="flex min-w-0 items-center gap-1.5">
                  {selectedTableInfo.type === 'view' ? (
                    <Eye className="h-3.5 w-3.5 flex-shrink-0 text-purple-500/70" />
                  ) : (
                    <Table2 className="h-3.5 w-3.5 flex-shrink-0 text-blue-500/70" />
                  )}
                  <span className="text-foreground truncate text-xs font-medium">
                    {selectedTableInfo.name}
                  </span>
                  <span className="text-muted-foreground/40 flex-shrink-0 text-xs tabular-nums">
                    {selectedTableInfo.rowCount.toLocaleString()} ×{' '}
                    {selectedTableInfo.columns.length}
                  </span>
                </div>

                <div className="ml-auto flex items-center gap-1">
                  {/* Mutation buttons — icon-only, tooltip explains */}
                  {isEditable && (
                    <>
                      <button
                        className="text-muted-foreground/50 hover:text-foreground hover:bg-muted inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors"
                        onClick={handleAddRow}
                        title={tHardcodedUi.raw(
                          'componentsFileRenderersSqliteRenderer.line941JsxAttrTitleInsertRow',
                        )}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="text-muted-foreground/50 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-red-500/10 hover:text-red-500"
                        onClick={handleDeleteSelected}
                        title={tHardcodedUi.raw(
                          'componentsFileRenderersSqliteRenderer.line948JsxAttrTitleDeleteSelectedRows',
                        )}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>

                      <div className="bg-border mx-0.5 h-4 w-px" />
                    </>
                  )}

                  {/* Quick search */}
                  <div className="relative">
                    <Search className="text-muted-foreground/40 absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2" />
                    <Input
                      type="text"
                      placeholder={tHardcodedUi.raw(
                        'componentsFileRenderersSqliteRenderer.line961JsxAttrPlaceholderFilter',
                      )}
                      autoComplete="off"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="h-7 w-40 pr-7 pl-7 text-xs"
                    />
                    {searchTerm && (
                      <button
                        onClick={() => setSearchTerm('')}
                        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  <button
                    className="text-muted-foreground/50 hover:text-foreground hover:bg-muted inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors"
                    onClick={handleExportCsv}
                    title={tHardcodedUi.raw(
                      'componentsFileRenderersSqliteRenderer.line979JsxAttrTitleExportAsCsv',
                    )}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* AG Grid — editable with full control */}
              <div className="flex-1 overflow-hidden">
                {tableData.rows.length > 0 ? (
                  <div className="h-full w-full">
                    <AgGridReact
                      ref={gridApiRef}
                      key={`${selectedTable}-${dataVersion}`}
                      theme={agTheme}
                      rowData={tableData.rows}
                      columnDefs={columnDefs}
                      defaultColDef={{
                        sortable: true,
                        filter: true,
                        resizable: true,
                        editable: isEditable,
                        minWidth: 80,
                        flex: tableData.columns.length <= 8 ? 1 : undefined,
                        width: tableData.columns.length > 8 ? 160 : undefined,
                        cellStyle: { cursor: isEditable ? 'text' : 'default' },
                        valueFormatter: (params: { value: unknown }) => {
                          const v = params.value;
                          if (v == null) return '';
                          if (typeof v === 'boolean') return v ? 'true' : 'false';
                          return String(v);
                        },
                      }}
                      // Editing
                      singleClickEdit={false}
                      stopEditingWhenCellsLoseFocus={true}
                      onCellValueChanged={handleCellValueChanged}
                      onCellDoubleClicked={handleCellDoubleClicked}
                      // Selection
                      rowSelection={rowSelection}
                      // Quick filter
                      quickFilterText={searchTerm}
                      cacheQuickFilter={true}
                      // Clipboard & text selection
                      enableCellTextSelection={true}
                      ensureDomOrder={true}
                      // Virtual scrolling
                      rowBuffer={20}
                      animateRows={false}
                      suppressColumnVirtualisation={tableData.columns.length <= 20}
                      tooltipShowDelay={300}
                      onFirstDataRendered={(event: FirstDataRenderedEvent) => {
                        if (tableData.columns.length > 8) {
                          try {
                            event.api.autoSizeAllColumns();
                          } catch {
                            /* ignore */
                          }
                        }
                      }}
                      overlayNoRowsTemplate={tHardcodedUi.raw(
                        'componentsFileRenderersSqliteRenderer.line1035JsxAttrOverlaynorowstemplateSpanClassTextMutedForegroundTextSmNo',
                      )}
                    />
                  </div>
                ) : (
                  <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
                    {tHardcodedUi.raw(
                      'componentsFileRenderersSqliteRenderer.line1040JsxTextNoDataInThisTable',
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── SCHEMA VIEW ───────────────────────────────────────── */}
          {viewMode === 'schema' && selectedTableInfo && (
            <div className="flex-1 space-y-4 overflow-auto p-4">
              {/* CREATE statement */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                    {tHardcodedUi.raw(
                      'componentsFileRenderersSqliteRenderer.line1054JsxTextCreateStatement',
                    )}
                  </h3>
                  <Button variant="muted" size="xs" onClick={handleCopySchema}>
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <pre className="bg-muted/50 text-foreground/80 overflow-x-auto rounded-2xl border p-4 font-mono text-xs whitespace-pre-wrap select-text">
                  {selectedTableInfo.sql || '-- No SQL available (system table or virtual table)'}
                </pre>
              </div>

              {/* Column details */}
              <div className="space-y-2">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                  {tHardcodedUi.raw('componentsFileRenderersSqliteRenderer.line1077JsxTextColumns')}
                  {selectedTableInfo.columns.length})
                </h3>
                <div className="overflow-hidden rounded-2xl border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-muted-foreground w-8 px-3 py-2 text-left font-medium">
                          #
                        </th>
                        <th className="text-muted-foreground px-3 py-2 text-left font-medium">
                          Name
                        </th>
                        <th className="text-muted-foreground px-3 py-2 text-left font-medium">
                          Type
                        </th>
                        <th className="text-muted-foreground w-16 px-3 py-2 text-center font-medium">
                          PK
                        </th>
                        <th className="text-muted-foreground w-20 px-3 py-2 text-center font-medium">
                          {tHardcodedUi.raw(
                            'componentsFileRenderersSqliteRenderer.line1087JsxTextNotNull',
                          )}
                        </th>
                        <th className="text-muted-foreground px-3 py-2 text-left font-medium">
                          Default
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedTableInfo.columns.map((col) => (
                        <tr
                          key={col.cid}
                          className="hover:bg-muted/30 border-b transition-colors last:border-0"
                        >
                          <td className="text-muted-foreground/50 px-3 py-2 tabular-nums">
                            {col.cid}
                          </td>
                          <td className="text-foreground px-3 py-2 font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {col.pk && <Key className="h-3 w-3 text-amber-500/70" />}
                              {col.name}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center gap-1">
                              {getTypeIcon(col.type)}
                              <span className="text-muted-foreground font-mono">
                                {col.type || 'ANY'}
                              </span>
                            </span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            {col.pk && (
                              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/10 text-xs font-semibold text-amber-500">
                                ✓
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {col.notnull && (
                              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500/10 text-xs font-semibold text-red-500">
                                ✓
                              </span>
                            )}
                          </td>
                          <td className="text-muted-foreground/60 px-3 py-2 font-mono">
                            {col.dflt_value ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Stats — compact inline */}
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/50">Rows</span>
                  <span className="font-medium tabular-nums">
                    {selectedTableInfo.rowCount.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/50">Columns</span>
                  <span className="font-medium tabular-nums">
                    {selectedTableInfo.columns.length}
                  </span>
                </div>
                {selectedTableInfo.columns.some((c) => c.pk) && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground/50">
                      {tHardcodedUi.raw(
                        'componentsFileRenderersSqliteRenderer.line1146JsxTextPrimaryKeys',
                      )}
                    </span>
                    <span className="font-medium tabular-nums">
                      {selectedTableInfo.columns.filter((c) => c.pk).length}
                    </span>
                  </div>
                )}
                {selectedTableInfo.columns.some((c) => c.notnull) && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground/50">
                      {tHardcodedUi.raw(
                        'componentsFileRenderersSqliteRenderer.line1152JsxTextNotNull',
                      )}
                    </span>
                    <span className="font-medium tabular-nums">
                      {selectedTableInfo.columns.filter((c) => c.notnull).length}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── QUERY VIEW ────────────────────────────────────────── */}
          {viewMode === 'query' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Query input */}
              <div className="flex-shrink-0 space-y-2 border-b p-3">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground/50 text-xs">SQL</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-muted-foreground/30 text-xs">
                      {typeof navigator !== 'undefined' && navigator.platform?.includes('Mac')
                        ? '⌘'
                        : 'Ctrl'}
                      {tHardcodedUi.raw(
                        'componentsFileRenderersSqliteRenderer.line1169JsxTextEnter',
                      )}
                    </span>
                    <button
                      className={cn(
                        'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-xs transition-colors',
                        sqlQuery.trim()
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'bg-muted text-muted-foreground cursor-not-allowed',
                      )}
                      onClick={runQuery}
                      disabled={isQueryRunning || !sqlQuery.trim()}
                    >
                      {isQueryRunning ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                      Run
                    </button>
                  </div>
                </div>
                <textarea
                  value={sqlQuery}
                  onChange={(e) => setSqlQuery(e.target.value)}
                  onKeyDown={handleQueryKeyDown}
                  placeholder={`SELECT * FROM "${selectedTable || 'table_name'}" LIMIT 100`}
                  className={cn(
                    'bg-muted/30 h-24 w-full cursor-text rounded-2xl border px-3 py-2 font-mono text-xs',
                    'focus:ring-ring resize-none focus:ring-1 focus:outline-none',
                    'placeholder:text-muted-foreground/30',
                  )}
                  spellCheck={false}
                />
              </div>

              {/* Query results */}
              <div className="flex flex-1 flex-col overflow-hidden">
                {queryResult?.error && (
                  <div className="flex-shrink-0 border-b border-red-500/20 bg-red-500/5 px-4 py-2 font-mono text-xs text-red-500 select-text">
                    Error: {queryResult.error}
                  </div>
                )}

                {queryResult && !queryResult.error && (
                  <div className="text-muted-foreground flex flex-shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
                    <span>
                      {queryResult.rowCount.toLocaleString()} row
                      {queryResult.rowCount !== 1 ? 's' : ''}
                    </span>
                    <span className="text-muted-foreground/30">·</span>
                    <span>{queryResult.time.toFixed(1)}ms</span>
                  </div>
                )}

                {queryResult && queryResult.rows.length > 0 && (
                  <div className="flex-1 overflow-hidden">
                    <Suspense fallback={<GridFallback />}>
                      <DataGrid
                        key={`query-${queryResult.time}`}
                        rowData={queryResult.rows}
                        className="h-full"
                      />
                    </Suspense>
                  </div>
                )}

                {!queryResult && (
                  <div className="flex flex-1 items-center justify-center">
                    <div className="space-y-2 text-center">
                      <Play className="text-muted-foreground/20 mx-auto h-8 w-8" />
                      <p className="text-muted-foreground/40 text-sm">
                        {tHardcodedUi.raw(
                          'componentsFileRenderersSqliteRenderer.line1237JsxTextWriteAQueryAndPressRun',
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {queryResult && queryResult.rows.length === 0 && !queryResult.error && (
                  <div className="flex flex-1 items-center justify-center">
                    <p className="text-muted-foreground/40 text-sm">
                      {tHardcodedUi.raw(
                        'componentsFileRenderersSqliteRenderer.line1246JsxTextQueryReturnedNoRows',
                      )}
                      {queryResult.time.toFixed(1)}ms)
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Cell expansion overlay ───────────────────────────────────── */}
      {expandedCell && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-[2px]"
          onClick={() => setExpandedCell(null)}
        >
          <div
            className="bg-background border-border/60 flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-foreground/70 truncate font-mono text-xs">
                  {expandedCell.column}
                </span>
                <span className="text-muted-foreground/30 shrink-0 text-xs tabular-nums">
                  row {expandedCell.rowIndex + 1}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {isEditable && expandedEditValue !== expandedCell.value && (
                  <Button variant="default" size="toolbar" onClick={handleExpandedSave}>
                    <Check className="h-3 w-3" />
                    Apply
                  </Button>
                )}
                <Button onClick={() => setExpandedCell(null)} variant="ghost" size="icon-sm">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
              {isEditable ? (
                <textarea
                  value={expandedEditValue}
                  onChange={(e) => setExpandedEditValue(e.target.value)}
                  className={cn(
                    'h-full min-h-[180px] w-full cursor-text bg-transparent p-4 font-mono text-sm',
                    'resize-none focus:outline-none',
                    'placeholder:text-muted-foreground/20',
                  )}
                  placeholder="NULL"
                  spellCheck={false}
                  autoFocus
                />
              ) : (
                <pre className="text-foreground/80 min-h-[180px] p-4 font-mono text-sm break-all whitespace-pre-wrap select-text">
                  {expandedCell.value || (
                    <span className="text-muted-foreground/30 italic">NULL</span>
                  )}
                </pre>
              )}
            </div>

            {/* Footer */}
            <div className="text-muted-foreground/30 border-t px-4 py-1.5 text-xs tabular-nums">
              {expandedEditValue.length.toLocaleString()} chars
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
