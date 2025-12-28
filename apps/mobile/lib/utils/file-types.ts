/**
 * Centralized file type utilities
 * Single source of truth for file type detection and preview capabilities
 */

// Extensions that can be previewed with rich rendering
export const PREVIEWABLE_EXTENSIONS = [
  'html', 'htm',
  'md', 'markdown',
  'json',
  'csv', 'tsv',
  'txt',
] as const;

// Document extensions (files that should use DocumentAttachment)
export const DOCUMENT_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv', 'json',
  'md', 'markdown',
  'html', 'htm',
] as const;

// Image extensions
export const IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif',
] as const;

/**
 * Get file extension from path or filename
 */
export function getExtension(filepath: string): string {
  return filepath.split('.').pop()?.toLowerCase() || '';
}

/**
 * Check if file extension is previewable (can show content preview)
 */
export function isPreviewableExtension(ext: string): boolean {
  return (PREVIEWABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Check if file extension should use DocumentAttachment
 */
export function isDocumentExtension(ext: string): boolean {
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Check if file is an image
 */
export function isImageExtension(ext: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Specific type checks
 */
export function isJsonExtension(ext: string): boolean {
  return ext.toLowerCase() === 'json';
}

export function isMarkdownExtension(ext: string): boolean {
  const e = ext.toLowerCase();
  return e === 'md' || e === 'markdown';
}

export function isHtmlExtension(ext: string): boolean {
  const e = ext.toLowerCase();
  return e === 'html' || e === 'htm';
}

export function isCsvExtension(ext: string): boolean {
  const e = ext.toLowerCase();
  return e === 'csv' || e === 'tsv';
}

