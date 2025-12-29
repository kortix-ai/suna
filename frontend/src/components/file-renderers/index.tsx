'use client';

// Re-export binary/non-editable renderers
export { PdfRenderer } from './pdf-renderer';
export { ImageRenderer } from './image-renderer';
export { VideoRenderer, InlineVideoPlayer } from './video-renderer';
export { BinaryRenderer } from './binary-renderer';
export { CsvRenderer } from './csv-renderer';
export { XlsxRenderer } from './xlsx-renderer';
// SpreadsheetViewer removed from barrel - imports Syncfusion (~1-2 MB)
// Import directly: import { SpreadsheetViewer } from '@/components/thread/tool-views/spreadsheet/SpreadsheetViewer'
export { PptxRenderer } from './pptx-renderer';
export { HtmlRenderer } from './html-renderer';
export { JsonRenderer } from './JsonRenderer';

// File type helpers
export type BinaryFileType = 'pdf' | 'image' | 'video' | 'binary' | 'csv' | 'xlsx' | 'pptx';

export function isBinaryFileType(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const binaryExtensions = [
    'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
    'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogg',
    'xlsx', 'xls', 'pptx', 'ppt', 'docx',
  ];
  return binaryExtensions.includes(extension);
}
