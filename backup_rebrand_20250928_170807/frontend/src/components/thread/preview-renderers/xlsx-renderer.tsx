"use client";

import React from 'react';
import { XlsxRenderer as UnifiedXlsxRenderer } from '@/components/file-renderers/xlsx-renderer';

interface XlsxRendererProps {
  content: string; // Path or blob URL for the XLSX file
  className?: string;
  onSheetChange?: (sheetIndex: number) => void; // Back-compat only
  activeSheetIndex?: number; // Back-compat only
  project?: any; // Back-compat only
}

// Thin wrapper to reuse the unified Luckysheet-based renderer everywhere
export function XlsxRenderer({
  content,
  className,
  onSheetChange: _onSheetChange,
  activeSheetIndex: _activeSheetIndex = 0,
  project: _project,
}: XlsxRendererProps) {
  return (
    <UnifiedXlsxRenderer
      filePath={content}
      fileName="spreadsheet.xlsx"
      className={className}
    />
  );
}