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
  'xlsx', 'xls',
  'pdf',
  'txt',
] as const;

// Image extensions
export const IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif',
] as const;

// Video extensions
export const VIDEO_EXTENSIONS = [
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v',
] as const;

// Code file extensions
export const CODE_EXTENSIONS = [
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'rb', 'php',
  'css', 'scss', 'sass', 'less',
  'sh', 'bash', 'zsh',
  'yaml', 'yml', 'toml',
  'sql',
] as const;

/**
 * Get file extension from path or filename
 */
export function getExtension(filepath: string): string {
  return filepath.split('.').pop()?.toLowerCase() || '';
}

/**
 * Check if file extension is previewable (HTML, MD, JSON, CSV, XLSX, PDF)
 */
export function isPreviewableExtension(ext: string): boolean {
  return (PREVIEWABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Check if file path is previewable
 */
export function isPreviewableFile(filepath: string): boolean {
  return isPreviewableExtension(getExtension(filepath));
}

/**
 * Check if file is an image
 */
export function isImageExtension(ext: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Check if file path is an image
 */
export function isImageFile(filepath: string): boolean {
  return isImageExtension(getExtension(filepath));
}

/**
 * Check if file is a code file
 */
export function isCodeExtension(ext: string): boolean {
  return (CODE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Check if file path is a code file
 */
export function isCodeFile(filepath: string): boolean {
  return isCodeExtension(getExtension(filepath));
}

/**
 * Specific type checks for rendering logic
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

export function isSpreadsheetExtension(ext: string): boolean {
  const e = ext.toLowerCase();
  return e === 'xlsx' || e === 'xls';
}

export function isPdfExtension(ext: string): boolean {
  return ext.toLowerCase() === 'pdf';
}

export function isTextExtension(ext: string): boolean {
  return ext.toLowerCase() === 'txt';
}

/**
 * Check if file is a video
 */
export function isVideoExtension(ext: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Check if file path is a video
 */
export function isVideoFile(filepath: string): boolean {
  return isVideoExtension(getExtension(filepath));
}

