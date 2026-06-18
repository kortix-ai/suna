'use client';

import React, { useCallback, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  type ColDef,
  type GridReadyEvent,
  type FirstDataRenderedEvent,
  ModuleRegistry,
  themeQuartz,
  colorSchemeDarkBlue,
  colorSchemeLight,
} from 'ag-grid-community';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

// Register all community modules once
ModuleRegistry.registerModules([AllCommunityModule]);

// ── Theme ────────────────────────────────────────────────────────────────
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

// ── Types ────────────────────────────────────────────────────────────────
export interface DataGridProps {
  /** Column definitions. If omitted, auto-generated from data keys. */
  columnDefs?: ColDef[];
  /** Row data array (objects keyed by header names). */
  rowData: Record<string, unknown>[];
  /** Quick-filter text (global search). */
  quickFilterText?: string;
  /** Column keys to hide. */
  hiddenColumns?: Set<string>;
  /** Whether the grid is read-only (default: true). */
  readOnly?: boolean;
  /** Container className. */
  className?: string;
  /** Called when grid is ready. */
  onGridReady?: (event: GridReadyEvent) => void;
  /** Whether to auto-size columns to fit content on first render. */
  autoSizeColumns?: boolean;
  /** Whether to suppress right-click context menu (default: false). */
  suppressContextMenu?: boolean;
  /** Status bar info text (e.g. "1,234 rows"). */
  statusText?: string;
}

// ── Component ────────────────────────────────────────────────────────────
export function DataGrid({
  columnDefs: columnDefsProp,
  rowData,
  quickFilterText,
  hiddenColumns,
  readOnly = true,
  className,
  onGridReady,
  autoSizeColumns = true,
  suppressContextMenu = false,
}: DataGridProps) {
  const gridRef = useRef<AgGridReact>(null);
  const { resolvedTheme } = useTheme();

  // ── Column defs ──────────────────────────────────────────────────────
  const columnDefs: ColDef[] = useMemo(() => {
    if (columnDefsProp) return columnDefsProp;

    // Auto-generate from first row keys
    if (!rowData || rowData.length === 0) return [];

    const keys = Object.keys(rowData[0]);
    return keys.map((key) => ({
      field: key,
      headerName: key,
      hide: hiddenColumns?.has(key) ?? false,
    }));
  }, [columnDefsProp, rowData, hiddenColumns]);

  // ── Default col def — Excel-like defaults ────────────────────────────
  const defaultColDef: ColDef = useMemo(
    () => ({
      sortable: true,
      filter: true,
      resizable: true,
      editable: !readOnly,
      minWidth: 80,
      flex: columnDefs.length <= 8 ? 1 : undefined,
      width: columnDefs.length > 8 ? 150 : undefined,
      suppressHeaderMenuButton: false,
      // Cell value formatting
      valueFormatter: (params: { value: unknown }) => {
        const v = params.value;
        if (v == null || v === '') return '';
        if (typeof v === 'number') return v.toLocaleString();
        if (typeof v === 'boolean') return v ? 'Yes' : 'No';
        return String(v);
      },
      cellClass: (params: { value: unknown }) => {
        if (typeof params.value === 'number') return 'ag-right-aligned-cell';
        return '';
      },
    }),
    [readOnly, columnDefs.length],
  );

  // ── Auto-size columns on first data render ───────────────────────────
  const handleFirstDataRendered = useCallback(
    (event: FirstDataRenderedEvent) => {
      if (!autoSizeColumns) return;
      try {
        // If few columns, let flex handle it. Otherwise auto-size.
        if (columnDefs.length > 8) {
          event.api.autoSizeAllColumns();
        }
      } catch {
        // Silently fail — auto-size can throw if columns aren't ready
      }
    },
    [autoSizeColumns, columnDefs.length],
  );

  const handleGridReady = useCallback(
    (event: GridReadyEvent) => {
      onGridReady?.(event);
    },
    [onGridReady],
  );

  // ── Theme resolved ───────────────────────────────────────────────────
  const theme = useMemo(() => {
    const colorScheme =
      resolvedTheme === 'dark' ? colorSchemeDarkBlue : colorSchemeLight;
    return gridTheme.withPart(colorScheme);
  }, [resolvedTheme]);

  // ── No data ──────────────────────────────────────────────────────────
  if (!rowData || rowData.length === 0) {
    return (
      <div
        className={cn(
          'w-full h-full flex items-center justify-center text-sm text-muted-foreground',
          className,
        )}
      >
        No data
      </div>
    );
  }

  return (
    <div className={cn('w-full h-full', className)}>
      <AgGridReact
        ref={gridRef}
        theme={theme}
        rowData={rowData}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        // Virtual scrolling — no DOM bloat
        rowBuffer={20}
        // Quick filter
        quickFilterText={quickFilterText}
        cacheQuickFilter={true}
        // Selection & clipboard
        enableCellTextSelection={true}
        ensureDomOrder={true}
        // Misc
        animateRows={false}
        suppressContextMenu={suppressContextMenu}
        suppressMovableColumns={false}
        suppressColumnVirtualisation={columnDefs.length <= 20}
        // Tooltips
        tooltipShowDelay={500}
        // Events
        onGridReady={handleGridReady}
        onFirstDataRendered={handleFirstDataRendered}
        // No rows overlay
        overlayNoRowsTemplate='<span class="text-muted-foreground text-sm">No matching rows</span>'
      />
    </div>
  );
}
