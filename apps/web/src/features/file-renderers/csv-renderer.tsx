'use client';

import { useTranslations } from 'next-intl';

import React, { useState, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import Papa from 'papaparse';
import { cn } from '@/lib/utils';
import {
  Search,
  FileSpreadsheet,
  Filter,
  Download,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import type { GridReadyEvent } from 'ag-grid-community';

// Lazy-load DataGrid — it pulls in AG Grid (~200KB gzipped)
const DataGrid = lazy(() =>
  import('@/components/ui/data-grid').then((m) => ({ default: m.DataGrid })),
);

function GridFallback() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex items-center justify-center h-full w-full">
      <div className="text-sm text-muted-foreground animate-pulse">{tHardcodedUi.raw('componentsFileRenderersCsvRenderer.line32JsxTextLoadingGrid')}</div>
    </div>
  );
}

// ── CSV Parsing ──────────────────────────────────────────────────────────
interface CsvRendererProps {
  content: string;
  className?: string;
  /** Compact mode for inline previews — hides search & column controls */
  compact?: boolean;
  /** Fixed container height for compact mode */
  containerHeight?: number;
}

function parseCSV(content: string) {
  if (!content) return { data: [], headers: [], meta: null };
  try {
    const results = Papa.parse(content, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    });
    const headers = results.meta?.fields || [];
    return { headers, data: results.data as Record<string, unknown>[], meta: results.meta };
  } catch (error) {
    console.error('Error parsing CSV:', error);
    return { headers: [] as string[], data: [] as Record<string, unknown>[], meta: null };
  }
}

// ── Component ────────────────────────────────────────────────────────────
export function CsvRenderer({
  content,
  className,
  compact = false,
}: CsvRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [searchTerm, setSearchTerm] = useState('');
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const gridApiRef = useRef<GridReadyEvent['api'] | null>(null);

  const { headers, data } = useMemo(() => parseCSV(content), [content]);
  const isEmpty = data.length === 0;

  const toggleColumnVisibility = useCallback((column: string) => {
    setHiddenColumns((prev) => {
      const s = new Set(prev);
      if (s.has(column)) s.delete(column);
      else s.add(column);
      return s;
    });
  }, []);

  const handleGridReady = useCallback((event: GridReadyEvent) => {
    gridApiRef.current = event.api;
  }, []);

  const handleExportCsv = useCallback(() => {
    gridApiRef.current?.exportDataAsCsv({ fileName: 'export.csv' });
  }, []);

  // ── Empty state ────────────────────────────────────────────────────────
  if (isEmpty) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        {compact ? (
          <div className="text-muted-foreground text-sm">{tHardcodedUi.raw('componentsFileRenderersCsvRenderer.line98JsxTextNoData')}</div>
        ) : (
          <div className="text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
              <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-foreground">{tHardcodedUi.raw('componentsFileRenderersCsvRenderer.line105JsxTextNoData')}</h3>
              <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsFileRenderersCsvRenderer.line106JsxTextThisCsvFileAppearsToBeEmptyOr')}</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Compact mode ───────────────────────────────────────────────────────
  if (compact) {
    return (
      <div className={cn('w-full h-full', className)}>
        <Suspense fallback={<GridFallback />}>
          <DataGrid
            rowData={data}
            hiddenColumns={hiddenColumns}
            className="h-full"
          />
        </Suspense>
      </div>
    );
  }

  // ── Full mode ──────────────────────────────────────────────────────────
  return (
    <div className={cn('w-full h-full flex flex-col bg-background', className)}>
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b bg-muted/30 px-4 py-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">CSV</span>
            <span className="text-xs text-muted-foreground">
              {data.length.toLocaleString()}{tHardcodedUi.raw('componentsFileRenderersCsvRenderer.line139JsxTextRows')}{headers.filter((h) => !hiddenColumns.has(h)).length} columns
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleExportCsv}>
              <Download className="h-3.5 w-3.5 mr-1" />
              Export
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <Filter className="h-3.5 w-3.5 mr-1" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 max-h-80 overflow-auto">
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsFileRenderersCsvRenderer.line157JsxTextShowHideColumns')}</div>
                <DropdownMenuSeparator />
                {headers.map((header) => (
                  <DropdownMenuCheckboxItem
                    key={header}
                    checked={!hiddenColumns.has(header)}
                    onCheckedChange={() => toggleColumnVisibility(header)}
                    className="text-xs"
                  >
                    {header}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input type="text"
            placeholder={tHardcodedUi.raw('componentsFileRenderersCsvRenderer.line178JsxAttrPlaceholderSearchAllColumns')} autoComplete="off"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-7 pl-8 pr-8 text-xs"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Grid ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<GridFallback />}>
          <DataGrid
            rowData={data}
            quickFilterText={searchTerm}
            hiddenColumns={hiddenColumns}
            onGridReady={handleGridReady}
            className="h-full"
          />
        </Suspense>
      </div>
    </div>
  );
}
