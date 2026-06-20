'use client';

// Re-export binary/non-editable renderers
export { PdfRenderer } from './pdf-renderer';
export { ImageRenderer } from './image-renderer';
export { VideoRenderer, InlineVideoPlayer } from './video-renderer';
export { BinaryRenderer } from './binary-renderer';
export { CsvRenderer } from './csv-renderer';
// XlsxRenderer kept out of barrel — lazy-loads Univer + ExcelJS (~500KB)
// Import via lazy: const XlsxRenderer = lazy(() => import('./xlsx-renderer').then(m => ({ default: m.XlsxRenderer })))
// SpreadsheetViewer (Syncfusion editor) also kept out of barrel (~1-2 MB)
// Import directly: import { SpreadsheetViewer } from '@/components/thread/tool-views/spreadsheet/SpreadsheetViewer'
export { PptxRenderer } from './pptx-renderer';
export { HtmlRenderer } from './html-renderer';
export { JsonRenderer } from './JsonRenderer';
export { DocxRenderer } from './docx-renderer';
export { ShowContentRenderer, ShowCarousel, showFavicon, showDomain, showAspectRatioToCSS, SHOW_IMAGE_EXT_RE, SHOW_VIDEO_EXT_RE, SHOW_AUDIO_EXT_RE, SHOW_PDF_EXT_RE, SHOW_CSV_EXT_RE, SHOW_XLSX_EXT_RE, SHOW_DOCX_EXT_RE, SHOW_PPTX_EXT_RE } from './show-content-renderer';
export type { ShowContentProps, ShowCarouselItem, ShowCarouselProps } from './show-content-renderer';

// File type helpers
export type BinaryFileType = 'pdf' | 'image' | 'video' | 'binary' | 'csv' | 'xlsx' | 'pptx' | 'docx';

export function isBinaryFileType(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const binaryExtensions = [
    'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
    'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogg',
    'xlsx', 'xls', 'pptx', 'ppt', 'docx',
  ];
  return binaryExtensions.includes(extension);
}
