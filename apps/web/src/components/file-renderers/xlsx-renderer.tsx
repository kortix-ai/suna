'use client';

/**
 * XlsxRenderer — True Excel-like viewer powered by Univer (Apache 2.0, free).
 *
 * Architecture:
 *   1. Load the XLSX/XLS file as ArrayBuffer
 *   2. Parse with ExcelJS (MIT) → extracts ALL cell data, styles, merges, sheets
 *   3. Convert to Univer IWorkbookData format (cell formatting, borders, etc.)
 *   4. Render with Univer's canvas spreadsheet engine — 1:1 Excel experience:
 *      • Row/column headers (A, B, C… / 1, 2, 3…)
 *      • Cell colors, fonts, borders, merged cells
 *      • Number formats, alignment, bold/italic
 *      • Sheet tabs, scrolling, zoom
 *      • Read-only mode, no toolbar/formula bar
 *
 * XLS (legacy): Falls back to SheetJS for parsing (data only, minimal styles).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { FileSpreadsheet, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/components/AuthProvider';

import '@univerjs/preset-sheets-core/lib/index.css';

// ── Types ───────────────────────────────────────────────────────────────

interface XlsxRendererProps {
  content?: string | null;
  filePath?: string;
  fileName: string;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
      sandbox_url?: string;
    };
  };
  onDownload?: () => void;
  isDownloading?: boolean;
}

type FileFormat = 'xlsx' | 'xls' | 'unknown';

// ── Univer data types (subset used for workbook creation) ───────────────

interface UniverBorderSide {
  s: number;
  cl: { rgb: string };
}

interface UniverStyle {
  ff?: string;
  fs?: number;
  it?: 0 | 1;
  bl?: 0 | 1;
  ul?: { s: 0 | 1 };
  st?: { s: 0 | 1 };
  cl?: { rgb: string };
  bg?: { rgb: string };
  ht?: number; // 0=left, 1=center, 2=right
  vt?: number; // 0=top, 1=middle, 2=bottom
  tb?: number; // 0=overflow, 1=wrap, 2=clip
  bd?: {
    t?: UniverBorderSide;
    b?: UniverBorderSide;
    l?: UniverBorderSide;
    r?: UniverBorderSide;
  };
  n?: { pattern: string };
}

interface UniverCell {
  v?: string | number | boolean;
  s?: UniverStyle;
  t?: number; // 1=string, 2=number, 3=boolean
}

interface UniverMerge {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

interface UniverSheetData {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  defaultRowHeight: number;
  defaultColumnWidth: number;
  cellData: Record<number, Record<number, UniverCell>>;
  mergeData: UniverMerge[];
  columnData?: Record<number, { w?: number }>;
  tabColor?: string;
}

interface UniverWorkbookData {
  id: string;
  name: string;
  appVersion: string;
  sheetOrder: string[];
  sheets: Record<string, UniverSheetData>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function argbToHex(color: unknown): string | undefined {
  if (!color) return undefined;
  const raw = typeof color === 'string' ? color : (color as { argb?: string })?.argb;
  if (!raw) return undefined;
  if (raw.length === 8) return `#${raw.slice(2)}`;
  if (raw.length === 6) return `#${raw}`;
  return undefined;
}

function detectExcelFormat(buffer: ArrayBuffer): FileFormat {
  const v = new Uint8Array(buffer);
  if (v.length >= 4 && v[0] === 0x50 && v[1] === 0x4B && v[2] === 0x03 && v[3] === 0x04) return 'xlsx';
  if (v.length >= 8 && v[0] === 0xD0 && v[1] === 0xCF && v[2] === 0x11 && v[3] === 0xE0) return 'xls';
  return 'unknown';
}

/** Convert Excel column letter to 0-based index: A→0, B→1, Z→25, AA→26 */
function colLetterToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/** Parse "A1" → { row: 0, col: 0 }, "C3" → { row: 2, col: 2 } */
function parseCellRef(ref: string): { row: number; col: number } {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return { row: 0, col: 0 };
  return { col: colLetterToIndex(match[1]), row: parseInt(match[2], 10) - 1 };
}

const BORDER_STYLE_MAP: Record<string, number> = {
  thin: 1, medium: 2, thick: 3, dotted: 4, dashed: 5,
  dashDot: 6, dashDotDot: 7, double: 8, hair: 9,
  mediumDashed: 10, mediumDashDot: 11, mediumDashDotDot: 12, slantDashDot: 13,
};

function convertBorderSide(side: unknown): UniverBorderSide | undefined {
  if (!side || typeof side !== 'object') return undefined;
  const s = side as { style?: string; color?: { argb?: string } };
  if (!s.style) return undefined;
  const hex = argbToHex(s.color) || '#000000';
  return { s: BORDER_STYLE_MAP[s.style] || 1, cl: { rgb: hex } };
}

// ── ExcelJS → Univer style converter ────────────────────────────────────

function convertStyle(exStyle: Record<string, unknown> | undefined): UniverStyle | undefined {
  if (!exStyle) return undefined;
  const us: UniverStyle = {};
  let hasStyle = false;

  // Font
  const font = exStyle.font as Record<string, unknown> | undefined;
  if (font) {
    if (font.bold) { us.bl = 1; hasStyle = true; }
    if (font.italic) { us.it = 1; hasStyle = true; }
    if (font.underline) { us.ul = { s: 1 }; hasStyle = true; }
    if (font.strike) { us.st = { s: 1 }; hasStyle = true; }
    const colorHex = argbToHex(font.color);
    if (colorHex) { us.cl = { rgb: colorHex }; hasStyle = true; }
    if (typeof font.size === 'number' && font.size !== 11) { us.fs = font.size; hasStyle = true; }
    if (typeof font.name === 'string') { us.ff = font.name; hasStyle = true; }
  }

  // Fill
  const fill = exStyle.fill as Record<string, unknown> | undefined;
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const bgHex = argbToHex(fill.fgColor);
    if (bgHex) { us.bg = { rgb: bgHex }; hasStyle = true; }
  }

  // Alignment
  const align = exStyle.alignment as Record<string, unknown> | undefined;
  if (align) {
    if (align.horizontal === 'center') { us.ht = 1; hasStyle = true; }
    else if (align.horizontal === 'right') { us.ht = 2; hasStyle = true; }
    else if (align.horizontal === 'left') { us.ht = 0; hasStyle = true; }
    if (align.vertical === 'middle') { us.vt = 1; hasStyle = true; }
    else if (align.vertical === 'bottom') { us.vt = 2; hasStyle = true; }
    if (align.wrapText) { us.tb = 1; hasStyle = true; }
  }

  // Borders
  const border = exStyle.border as Record<string, unknown> | undefined;
  if (border) {
    const bd: UniverStyle['bd'] = {};
    const t = convertBorderSide(border.top); if (t) { bd.t = t; hasStyle = true; }
    const b = convertBorderSide(border.bottom); if (b) { bd.b = b; hasStyle = true; }
    const l = convertBorderSide(border.left); if (l) { bd.l = l; hasStyle = true; }
    const r = convertBorderSide(border.right); if (r) { bd.r = r; hasStyle = true; }
    if (hasStyle) us.bd = bd;
  }

  // Number format
  if (typeof exStyle.numFmt === 'string' && exStyle.numFmt) {
    us.n = { pattern: exStyle.numFmt };
    hasStyle = true;
  }

  return hasStyle ? us : undefined;
}

// ── ExcelJS cell value resolver ─────────────────────────────────────────

function resolveCellValue(raw: unknown): { v: string | number | boolean; t: number } | null {
  if (raw == null || raw === '') return null;

  // Formula result
  if (typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)) {
    return resolveCellValue((raw as { result: unknown }).result);
  }

  // Rich text
  if (typeof raw === 'object' && 'richText' in (raw as Record<string, unknown>)) {
    const text = ((raw as { richText: { text: string }[] }).richText || []).map((t) => t.text).join('');
    return text ? { v: text, t: 1 } : null;
  }

  // Hyperlink
  if (typeof raw === 'object' && 'text' in (raw as Record<string, unknown>)) {
    return { v: String((raw as { text: string }).text), t: 1 };
  }

  // Date
  if (raw instanceof Date) {
    return { v: raw.toLocaleDateString(), t: 1 };
  }

  // Error
  if (typeof raw === 'object' && 'error' in (raw as Record<string, unknown>)) {
    return { v: String((raw as { error: string }).error), t: 1 };
  }

  // Primitives
  if (typeof raw === 'number') return { v: raw, t: 2 };
  if (typeof raw === 'boolean') return { v: raw, t: 3 };
  if (typeof raw === 'string') return { v: raw, t: 1 };

  return { v: String(raw), t: 1 };
}

// ── Parse XLSX → Univer workbook data ───────────────────────────────────

async function parseToUniverData(arrayBuffer: ArrayBuffer, format: FileFormat, fileName: string): Promise<UniverWorkbookData> {
  if (format === 'xls') {
    return parseXlsToUniverData(arrayBuffer, fileName);
  }
  return parseXlsxToUniverData(arrayBuffer, fileName);
}

async function parseXlsxToUniverData(arrayBuffer: ArrayBuffer, fileName: string): Promise<UniverWorkbookData> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();

  // ExcelJS's reconcile() crashes with "Cannot read properties of undefined (reading 'anchors')"
  // on workbooks containing certain drawings/images/charts. When that happens, fall back to
  // SheetJS which parses data + merges correctly (styles are lost but content is preserved).
  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch (e) {
    console.warn('[XlsxRenderer] ExcelJS load failed, falling back to SheetJS:', e);
    return parseXlsToUniverData(arrayBuffer, fileName);
  }

  const sheetOrder: string[] = [];
  const sheets: Record<string, UniverSheetData> = {};

  try {
  workbook.eachSheet((ws) => {
    const sheetId = `sheet-${sheetOrder.length}`;
    const sheetName = ws.name || `Sheet ${sheetOrder.length + 1}`;
    sheetOrder.push(sheetId);

    const cellData: Record<number, Record<number, UniverCell>> = {};
    const mergeData: UniverMerge[] = [];
    let maxRow = 0;
    let maxCol = 0;

    // Extract cell data with styles
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const rowIdx = rowNumber - 1;
      if (rowIdx > maxRow) maxRow = rowIdx;

      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const colIdx = colNumber - 1;
        if (colIdx > maxCol) maxCol = colIdx;

        const resolved = resolveCellValue(cell.value);
        if (!resolved && !cell.style) return;

        const uCell: UniverCell = {};
        if (resolved) {
          uCell.v = resolved.v;
          uCell.t = resolved.t;
        }

        const style = convertStyle(cell.style as Record<string, unknown> | undefined);
        if (style) uCell.s = style;

        if (uCell.v != null || uCell.s) {
          if (!cellData[rowIdx]) cellData[rowIdx] = {};
          cellData[rowIdx][colIdx] = uCell;
        }
      });
    });

    // Extract merged cells
    const merges = (ws as unknown as { _merges?: Record<string, unknown>; model?: { merges?: string[] } })
      ?.model?.merges;
    if (merges && Array.isArray(merges)) {
      for (const range of merges) {
        const parts = String(range).split(':');
        if (parts.length === 2) {
          const start = parseCellRef(parts[0]);
          const end = parseCellRef(parts[1]);
          mergeData.push({
            startRow: start.row,
            startColumn: start.col,
            endRow: end.row,
            endColumn: end.col,
          });
        }
      }
    }

    // Extract column widths
    const columnData: Record<number, { w?: number }> = {};
    ws.columns?.forEach((col, idx) => {
      if (col.width) {
        // ExcelJS width is in characters, Univer uses pixels (~7px per character)
        columnData[idx] = { w: Math.round(col.width * 7.5) };
      }
    });

    sheets[sheetId] = {
      id: sheetId,
      name: sheetName,
      rowCount: Math.max(maxRow + 50, 200),
      columnCount: Math.max(maxCol + 10, 26),
      defaultRowHeight: 24,
      defaultColumnWidth: 80,
      cellData,
      mergeData,
      columnData: Object.keys(columnData).length > 0 ? columnData : undefined,
      tabColor: (ws.properties as unknown as Record<string, unknown>)?.tabColor
        ? argbToHex((ws.properties as unknown as Record<string, { argb?: string }>).tabColor)
        : undefined,
    };
  });
  } catch (e) {
    console.warn('[XlsxRenderer] ExcelJS extraction failed, falling back to SheetJS:', e);
    return parseXlsToUniverData(arrayBuffer, fileName);
  }

  // If ExcelJS loaded but produced zero sheets, fall back to SheetJS.
  if (sheetOrder.length === 0) {
    console.warn('[XlsxRenderer] ExcelJS produced no sheets, falling back to SheetJS');
    return parseXlsToUniverData(arrayBuffer, fileName);
  }

  return {
    id: 'xlsx-viewer',
    name: fileName || 'Spreadsheet',
    appVersion: '1.0.0',
    sheetOrder,
    sheets,
  };
}

async function parseXlsToUniverData(arrayBuffer: ArrayBuffer, fileName: string): Promise<UniverWorkbookData> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });

  const sheetOrder: string[] = [];
  const sheets: Record<string, UniverSheetData> = {};

  (wb.SheetNames || []).forEach((name, idx) => {
    const sheetId = `sheet-${idx}`;
    sheetOrder.push(sheetId);

    const ws = wb.Sheets[name];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

    const cellData: Record<number, Record<number, UniverCell>> = {};
    let maxCol = 0;

    rows.forEach((row, rowIdx) => {
      if (!row || !Array.isArray(row)) return;
      row.forEach((val, colIdx) => {
        if (val == null || val === '') return;
        if (colIdx > maxCol) maxCol = colIdx;

        const uCell: UniverCell = {};
        if (val instanceof Date) {
          uCell.v = val.toLocaleDateString();
          uCell.t = 1;
        } else if (typeof val === 'number') {
          uCell.v = val;
          uCell.t = 2;
        } else if (typeof val === 'boolean') {
          uCell.v = val;
          uCell.t = 3;
        } else {
          uCell.v = String(val);
          uCell.t = 1;
        }

        if (!cellData[rowIdx]) cellData[rowIdx] = {};
        cellData[rowIdx][colIdx] = uCell;
      });
    });

    // Extract merges from SheetJS
    const mergeData: UniverMerge[] = [];
    if (ws['!merges']) {
      for (const m of ws['!merges']) {
        mergeData.push({
          startRow: m.s.r,
          startColumn: m.s.c,
          endRow: m.e.r,
          endColumn: m.e.c,
        });
      }
    }

    sheets[sheetId] = {
      id: sheetId,
      name,
      rowCount: Math.max(rows.length + 50, 200),
      columnCount: Math.max(maxCol + 10, 26),
      defaultRowHeight: 24,
      defaultColumnWidth: 80,
      cellData,
      mergeData,
    };
  });

  return {
    id: 'xlsx-viewer',
    name: fileName || 'Spreadsheet',
    appVersion: '1.0.0',
    sheetOrder,
    sheets,
  };
}

// ── Component ───────────────────────────────────────────────────────────

/**
 * Imperative container pattern:
 * Univer manages its own DOM tree (canvas, divs, etc.) inside a container.
 * React must NEVER touch that container or it will crash with "removeChild" errors.
 *
 * Solution: React owns a stable wrapper div. We imperatively create/destroy
 * a child div for Univer — React never sees it in its virtual DOM.
 */

export function XlsxRenderer({
  filePath,
  fileName,
  className,
  sandboxId,
  project,
}: XlsxRendererProps) {
  const { session } = useAuth();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const univerInstanceRef = useRef<{
    dispose: () => void;
    container: HTMLDivElement;
  } | null>(null);
  const mountedRef = useRef(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const xlsxPath = filePath || fileName;
  const resolvedSandboxId = sandboxId || project?.sandbox?.id;

  // ── Teardown helper ────────────────────────────────────────────────
  const teardown = useCallback(() => {
    if (univerInstanceRef.current) {
      const { dispose, container } = univerInstanceRef.current;
      univerInstanceRef.current = null;
      try { dispose(); } catch { /* Univer may already be disposed */ }
      // Remove the imperatively-created container from the wrapper
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    }
  }, []);

  // ── Main effect: load file → parse → mount Univer ─────────────────
  useEffect(() => {
    // Guard against React StrictMode double-mount
    if (mountedRef.current) return;
    mountedRef.current = true;

    const wrapper = wrapperRef.current;
    if (!wrapper || !xlsxPath) return;

    let cancelled = false;

    async function init() {
      setIsLoading(true);
      setError(null);

      try {
        // 1. Load file as ArrayBuffer
        let arrayBuffer: ArrayBuffer;
        if (xlsxPath.startsWith('blob:')) {
          const resp = await fetch(xlsxPath);
          if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
          arrayBuffer = await resp.arrayBuffer();
        } else {
          const { readFileAsBlob } = await import('@/features/files/api/opencode-files');
          const blob = await readFileAsBlob(xlsxPath);
          arrayBuffer = await blob.arrayBuffer();
        }

        if (cancelled) return;

        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error('Empty file received');
        }

        // 2. Detect format and parse → Univer workbook data
        const format = detectExcelFormat(arrayBuffer);
        const workbookData = await parseToUniverData(arrayBuffer, format, fileName);

        if (cancelled) return;

        if (!workbookData.sheetOrder.length) {
          throw new Error('No sheets found in file');
        }

        // 3. Create an imperatively-managed container (React never touches this)
        const container = document.createElement('div');
        container.style.cssText = 'width:100%;height:100%;';
        wrapper!.appendChild(container);

        // 4. Initialize Univer inside the imperatively-created container
        const { createUniver, LocaleType, mergeLocales } = await import('@univerjs/presets');
        const { UniverSheetsCorePreset } = await import('@univerjs/preset-sheets-core');
        const sheetsCoreEnUS = (await import('@univerjs/preset-sheets-core/locales/en-US')).default;

        if (cancelled) {
          wrapper!.removeChild(container);
          return;
        }

        const { univerAPI } = createUniver({
          locale: LocaleType.EN_US,
          locales: {
            [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS),
          },
          presets: [
            UniverSheetsCorePreset({
              container,
              toolbar: false,
              contextMenu: true,
              formulaBar: false,
              footer: { sheetBar: true, statisticBar: true },
            }),
          ],
        });

        // Store for cleanup
        univerInstanceRef.current = {
          dispose: () => { try { univerAPI.dispose(); } catch { /* ignore */ } },
          container,
        };

        // 5. Create workbook with parsed data
        univerAPI.createWorkbook(workbookData as Parameters<typeof univerAPI.createWorkbook>[0]);

        // 6. Set read-only after Univer finishes rendering
        try {
          univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }: { stage: unknown }) => {
            if (stage === univerAPI.Enum.LifecycleStages.Rendered) {
              try {
                const fWorkbook = univerAPI.getActiveWorkbook();
                if (fWorkbook) {
                  const unitId = fWorkbook.getId();
                  const permission = fWorkbook.getPermission();
                  permission.setWorkbookEditPermission(unitId, false);
                  permission.setPermissionDialogVisible(false);
                }
              } catch { /* permission API may differ */ }
              if (!cancelled) setIsLoading(false);
            }
          });
        } catch { /* event API may differ between versions */ }

        // Fallback: if Rendered event never fires, still clear loading
        setTimeout(() => { if (!cancelled) setIsLoading(false); }, 2000);
      } catch (e: unknown) {
        console.error('[XlsxRenderer] Error:', e);
        if (!cancelled) {
          setError((e as Error)?.message || 'Failed to load spreadsheet');
          setIsLoading(false);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      teardown();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xlsxPath, resolvedSandboxId, session?.access_token]);

  // ── Retry handler ─────────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    teardown();
    mountedRef.current = false;
    setError(null);
    setIsLoading(true);
    // Force re-mount by toggling a state that triggers the effect
    // The simplest way: just re-run the init inline
    const wrapper = wrapperRef.current;
    if (!wrapper || !xlsxPath) return;

    let cancelled = false;

    (async () => {
      try {
        let arrayBuffer: ArrayBuffer;
        if (xlsxPath.startsWith('blob:')) {
          const resp = await fetch(xlsxPath);
          if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
          arrayBuffer = await resp.arrayBuffer();
        } else {
          const { readFileAsBlob } = await import('@/features/files/api/opencode-files');
          const blob = await readFileAsBlob(xlsxPath);
          arrayBuffer = await blob.arrayBuffer();
        }

        if (cancelled || !arrayBuffer?.byteLength) throw new Error('Empty file received');

        const format = detectExcelFormat(arrayBuffer);
        const workbookData = await parseToUniverData(arrayBuffer, format, fileName);

        if (cancelled || !workbookData.sheetOrder.length) throw new Error('No sheets found');

        const container = document.createElement('div');
        container.style.cssText = 'width:100%;height:100%;';
        wrapper!.appendChild(container);

        const { createUniver, LocaleType, mergeLocales } = await import('@univerjs/presets');
        const { UniverSheetsCorePreset } = await import('@univerjs/preset-sheets-core');
        const sheetsCoreEnUS = (await import('@univerjs/preset-sheets-core/locales/en-US')).default;

        if (cancelled) { wrapper.removeChild(container); return; }

        const { univerAPI } = createUniver({
          locale: LocaleType.EN_US,
          locales: { [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS) },
          presets: [
            UniverSheetsCorePreset({ container, toolbar: false, contextMenu: true, formulaBar: false, footer: { sheetBar: true, statisticBar: true } }),
          ],
        });

        univerInstanceRef.current = {
          dispose: () => { try { univerAPI.dispose(); } catch { /* */ } },
          container,
        };

        univerAPI.createWorkbook(workbookData as Parameters<typeof univerAPI.createWorkbook>[0]);

        try {
          univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }: { stage: unknown }) => {
            if (stage === univerAPI.Enum.LifecycleStages.Rendered) {
              try {
                const wb = univerAPI.getActiveWorkbook();
                if (wb) {
                  const perm = wb.getPermission();
                  perm.setWorkbookEditPermission(wb.getId(), false);
                  perm.setPermissionDialogVisible(false);
                }
              } catch { /* */ }
              if (!cancelled) setIsLoading(false);
            }
          });
        } catch { /* */ }

        setTimeout(() => { if (!cancelled) setIsLoading(false); }, 2000);
      } catch (e: unknown) {
        if (!cancelled) {
          setError((e as Error)?.message || 'Failed to load spreadsheet');
          setIsLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [xlsxPath, fileName, teardown]);

  // ── Error state ───────────────────────────────────────────────────
  if (error) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-foreground">Failed to load spreadsheet</h3>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
          <Button onClick={handleRetry} variant="outline" size="sm">
            <RefreshCw className="w-3 h-3 mr-2" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className={cn('w-full h-full relative', className)}>
      {/*
        Stable wrapper div — React owns this.
        Univer's container is created/destroyed imperatively as a child,
        so React never tries to reconcile Univer's DOM nodes.
      */}
      <div
        ref={wrapperRef}
        className="w-full h-full"
        style={{ minHeight: 300 }}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center">
          <div className="text-sm text-muted-foreground animate-pulse">Loading spreadsheet…</div>
        </div>
      )}
    </div>
  );
}
