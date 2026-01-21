/**
 * File Utilities
 * Helper functions for file handling and conversion
 */

import { Attachment } from '@/hooks/useChat';

/**
 * Normalize and sanitize filename for Unix compatibility
 * - Normalizes to NFC (Normalized Form Canonical Composition)
 * - Replaces Unicode spaces with regular spaces
 * - Sanitizes special characters that cause issues in Unix
 * - URL-decodes percent-encoded characters
 */
export function normalizeFilenameToNFC(filename: string): string {
  try {
    // First, URL-decode if needed (handles %20, %E2%80%AF, etc.)
    let normalized = filename;
    try {
      normalized = decodeURIComponent(filename);
    } catch {
      // If decode fails, use original
      normalized = filename;
    }
    
    // Normalize to NFC (Normalized Form Composed)
    normalized = normalized.normalize('NFC');
    
    // Replace problematic Unicode spaces with regular ASCII spaces
    const unicodeSpaces = [
      '\u00A0', // Non-breaking space
      '\u2000', // En quad
      '\u2001', // Em quad  
      '\u2002', // En space
      '\u2003', // Em space
      '\u2004', // Three-per-em space
      '\u2005', // Four-per-em space
      '\u2006', // Six-per-em space
      '\u2007', // Figure space
      '\u2008', // Punctuation space
      '\u2009', // Thin space
      '\u200A', // Hair space
      '\u202F', // Narrow no-break space (common in macOS screenshots)
      '\u205F', // Medium mathematical space
      '\u3000', // Ideographic space
    ];
    
    for (const unicodeSpace of unicodeSpaces) {
      normalized = normalized.replaceAll(unicodeSpace, ' ');
    }
    
    // Replace problematic characters for Unix filesystems
    // These can cause issues with shell commands and file operations
    const replacements: Record<string, string> = {
      ':': '-',  // Colons not allowed in many filesystems
      '/': '-',  // Forward slash is path separator
      '\\': '-', // Backslash is escape character
      '*': '-',  // Wildcard character
      '?': '-',  // Wildcard character
      '"': "'",  // Double quotes can break shell commands
      '<': '-',  // Redirect operator
      '>': '-',  // Redirect operator
      '|': '-',  // Pipe operator
    };
    
    for (const [bad, good] of Object.entries(replacements)) {
      normalized = normalized.replaceAll(bad, good);
    }
    
    // Trim leading/trailing spaces and dots (can cause issues)
    normalized = normalized.trim().replace(/^\.+|\.+$/g, '');
    
    // If filename is empty after sanitization, use a default
    if (!normalized) {
      normalized = 'file';
    }
    
    return normalized;
  } catch (error) {
    console.warn('Failed to normalize filename:', filename, error);
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_'); // Fallback: keep only safe chars
  }
}

/**
 * Convert React Native Attachment to FormData-compatible file object
 * React Native FormData accepts objects with uri, name, and type properties
 */
export interface FormDataFile {
  uri: string;
  name: string;
  type: string;
}

/**
 * Convert attachment to FormData-compatible format
 */
export async function convertAttachmentToFormDataFile(
  attachment: Attachment
): Promise<FormDataFile> {
  const normalizedName = normalizeFilenameToNFC(
    attachment.name || extractFilenameFromUri(attachment.uri)
  );

  // Determine MIME type
  const mimeType = attachment.mimeType || inferMimeTypeFromExtension(normalizedName);

  return {
    uri: attachment.uri,
    name: normalizedName,
    type: mimeType,
  };
}

/**
 * Convert multiple attachments to FormData-compatible format
 */
export async function convertAttachmentsToFormDataFiles(
  attachments: Attachment[]
): Promise<FormDataFile[]> {
  return Promise.all(
    attachments.map((attachment) => convertAttachmentToFormDataFile(attachment))
  );
}

/**
 * Extract filename from URI
 */
function extractFilenameFromUri(uri: string): string {
  const parts = uri.split('/');
  const filename = parts[parts.length - 1];
  // Remove query parameters if present
  return filename.split('?')[0];
}

/**
 * Infer MIME type from file extension
 */
function inferMimeTypeFromExtension(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop();
  
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    
    // Videos
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    
    // Archives
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    
    // Code
    js: 'text/javascript',
    jsx: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    html: 'text/html',
    css: 'text/css',
    py: 'text/x-python',
    java: 'text/x-java',
    cpp: 'text/x-c++src',
    c: 'text/x-csrc',
    go: 'text/x-go',
    rs: 'text/x-rust',
    
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
  };
  
  return mimeTypes[extension || ''] || 'application/octet-stream';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Validate file size (default max 50MB)
 */
export function validateFileSize(
  size: number | undefined,
  maxSizeMB: number = 50
): { valid: boolean; error?: string } {
  if (!size) {
    return { valid: true };
  }
  
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  
  if (size > maxSizeBytes) {
    return {
      valid: false,
      error: `File size exceeds ${maxSizeMB}MB limit`,
    };
  }
  
  return { valid: true };
}

/**
 * Generate file reference text for message
 * Used when uploading files to sandbox for existing threads
 */
export function generateFileReference(filepath: string): string {
  return `[Uploaded File: ${filepath}]`;
}

/**
 * Generate multiple file references
 */
export function generateFileReferences(filepaths: string[]): string {
  return filepaths.map(generateFileReference).join('\n');
}

