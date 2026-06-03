/**
 * Centralized file type utilities
 * Single source of truth for file type detection and preview capabilities
 */

// Extensions that can be previewed with rich rendering
const PREVIEWABLE_EXTENSIONS = [
  'html', 'htm',
  'md', 'markdown',
  'json',
  'csv', 'tsv',
  'txt',
  'docx',
  'pdf',
] as const;

// Document extensions (files that should use DocumentAttachment)
const DOCUMENT_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv', 'json',
  'md', 'markdown',
  'html', 'htm',
] as const;

// Image extensions
const IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif',
] as const;

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

export function isDocxExtension(ext: string): boolean {
  return ext.toLowerCase() === 'docx';
}

export function isPdfExtension(ext: string): boolean {
  return ext.toLowerCase() === 'pdf';
}
