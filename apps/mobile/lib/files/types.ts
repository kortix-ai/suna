/**
 * File Management Types
 */

export interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  mod_time?: string;
}

export interface BreadcrumbSegment {
  name: string;
  path: string;
  isLast: boolean;
}

export enum FilePreviewType {
  IMAGE = 'image',
  PDF = 'pdf',
  MARKDOWN = 'markdown',
  CSV = 'csv',
  XLSX = 'xlsx',
  TEXT = 'text',
  DOCUMENT = 'document',
  OTHER = 'other',
}

export type FileOperation = 
  | { type: 'upload'; file: File; path: string }
  | { type: 'download'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'create_folder'; path: string };

export interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

export interface FileOperationResult {
  success: boolean;
  error?: string;
  data?: any;
}

/**
 * Get file preview type from extension
 */
export function getFilePreviewType(filename: string): FilePreviewType {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const documentExtensions = ['pdf'];
  const markdownExtensions = ['md', 'markdown'];
  const csvExtensions = ['csv', 'tsv'];
  const xlsxExtensions = ['xlsx', 'xls'];
  const textExtensions = ['txt', 'log', 'json', 'xml', 'yaml', 'yml'];
  
  if (imageExtensions.includes(ext)) return FilePreviewType.IMAGE;
  if (documentExtensions.includes(ext)) return FilePreviewType.PDF;
  if (markdownExtensions.includes(ext)) return FilePreviewType.MARKDOWN;
  if (csvExtensions.includes(ext)) return FilePreviewType.CSV;
  if (xlsxExtensions.includes(ext)) return FilePreviewType.XLSX;
  if (textExtensions.includes(ext)) return FilePreviewType.TEXT;
  
  return FilePreviewType.OTHER;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Normalize path to always start with /workspace
 */
export function normalizePath(path: string | null | undefined): string {
  if (!path || typeof path !== 'string') return '/workspace';
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return '/workspace';
  return trimmed.startsWith('/workspace') 
    ? trimmed 
    : `/workspace/${trimmed.replace(/^\//, '')}`;
}

/**
 * Get breadcrumb segments from path
 */
export function getBreadcrumbSegments(path: string): BreadcrumbSegment[] {
  const normalized = normalizePath(path);
  const cleanPath = normalized.replace(/^\/workspace\/?/, '');
  
  if (!cleanPath) return [];
  
  const parts = cleanPath.split('/').filter(Boolean);
  let currentPath = '/workspace';
  
  return parts.map((part, index) => {
    currentPath = `${currentPath}/${part}`;
    return {
      name: part,
      path: currentPath,
      isLast: index === parts.length - 1,
    };
  });
}

