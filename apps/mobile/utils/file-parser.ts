import { SERVER_URL } from '@/constants/Server';

export interface ParsedFileContent {
  attachments: string[];
  cleanContent: string;
}

/**
 * Construct the API URL for file content
 */
export function getFileUrl(sandboxId: string | undefined, path: string): string {
  if (!sandboxId) return path;

  // Ensure path starts with /workspace
  if (!path.startsWith('/workspace')) {
    path = `/workspace/${path.startsWith('/') ? path.substring(1) : path}`;
  }

  // Handle any potential Unicode escape sequences
  try {
    path = path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => {
      return String.fromCharCode(parseInt(hexCode, 16));
    });
  } catch (e) {
    console.error('Error processing Unicode escapes in path:', e);
  }

  // Remove /api suffix from SERVER_URL since our endpoint structure might be different
  const baseUrl = SERVER_URL.replace('/api', '');
  const url = new URL(`${baseUrl}/sandboxes/${sandboxId}/files/content`);
  url.searchParams.append('path', path);

  return url.toString();
}

/**
 * Parse file attachments from message content and return clean content + attachments
 * Now supports using cached files from message metadata
 */
export function parseFileAttachments(
  content: string, 
  cachedFiles?: any[]
): { attachments: (string | any)[], cleanContent: string } {
  const fileRegex = /\[Uploaded File: ([^\]]+)\]/g;
  const matches = [];
  let match;
  
  while ((match = fileRegex.exec(content)) !== null) {
    matches.push(match[1]);
  }
  
  // Remove file references from content
  const cleanContent = content.replace(fileRegex, '').trim();
  
  // If we have cached files, use them instead of just file paths
  if (cachedFiles && cachedFiles.length > 0) {
    console.log('[parseFileAttachments] Using cached files:', cachedFiles.length);
    return {
      attachments: cachedFiles, // Return UploadedFile objects with localUri/cachedBlob
      cleanContent
    };
  }
  
  // Fallback to file paths for server loading
  return {
    attachments: matches,
    cleanContent
  };
}

/**
 * File type detection based on extension
 */
export type FileType = 
  | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'code' | 'other';

export function getFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'log', 'csv'].includes(ext)) return 'text';
  if (['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'py'].includes(ext)) return 'code';
  
  return 'other';
}

/**
 * Generate file size estimation based on filename and type
 */
export function getEstimatedFileSize(filepath: string, type: FileType): string {
  const base = (filepath.length * 5) % 800 + 200;
  
  const multipliers: Record<FileType, number> = {
    image: 5.0,
    video: 20.0,
    audio: 10.0,
    pdf: 8.0,
    text: 0.3,
    code: 0.5,
    other: 1.0
  };
  
  const size = base * multipliers[type];
  
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
} 