'use client';

// Re-export binary/non-editable renderers
export { PdfRenderer } from './pdf-renderer';
export { ImageRenderer } from './image-renderer';
export { BinaryRenderer } from './binary-renderer';
export { CsvRenderer } from './csv-renderer';
export { XlsxRenderer } from './xlsx-renderer';
export { PptxRenderer } from './pptx-renderer';
export { HtmlRenderer } from './html-renderer';

// File type helpers
export type BinaryFileType = 'pdf' | 'image' | 'binary' | 'csv' | 'xlsx' | 'pptx';

export function isBinaryFileType(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const binaryExtensions = [
    'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
    'xlsx', 'xls', 'pptx', 'ppt', 'docx',
  ];
  return binaryExtensions.includes(extension);
}
