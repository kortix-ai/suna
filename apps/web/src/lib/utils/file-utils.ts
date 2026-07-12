/**
 * Centralized file utilities
 * Consolidated from file-attachment.tsx for reuse across components
 */

import {
    FileText, FileImage, FileCode, FileSpreadsheet, FileVideo,
    FileAudio, FileType, Database, Archive, File
} from 'lucide-react';
function getExtension(filename: string): string {
    return filename.split('.').pop()?.toLowerCase() || '';
}

export type FileType =
    | 'image' | 'code' | 'text' | 'pdf'
    | 'audio' | 'video' | 'spreadsheet'
    | 'archive' | 'database' | 'markdown'
    | 'csv'
    | 'other';

/**
 * Get file type from filename
 */
export function getFileType(filename: string): FileType {
    const ext = getExtension(filename);

    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif'].includes(ext)) return 'image';
    if (['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'py', 'java', 'c', 'cpp'].includes(ext)) return 'code';
    if (['txt', 'log', 'env'].includes(ext)) return 'text';
    if (['md', 'markdown'].includes(ext)) return 'markdown';
    if (ext === 'pdf') return 'pdf';
    if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio';
    if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
    if (['csv', 'tsv'].includes(ext)) return 'csv';
    if (['xls', 'xlsx'].includes(ext)) return 'spreadsheet';
    if (['zip', 'rar', 'tar', 'gz'].includes(ext)) return 'archive';
    if (['db', 'sqlite', 'sql'].includes(ext)) return 'database';

    return 'other';
}

/**
 * Get appropriate icon component for file type
 */
export function getFileIcon(type: FileType) {
    const icons: Record<FileType, typeof FileImage> = {
        image: FileImage,
        code: FileCode,
        text: FileText,
        markdown: FileText,
        pdf: FileType,
        audio: FileAudio,
        video: FileVideo,
        spreadsheet: FileSpreadsheet,
        csv: FileSpreadsheet,
        archive: Archive,
        database: Database,
        other: File
    };

    return icons[type];
}

/**
 * Generate human-readable display name for file type
 */
export function getTypeLabel(type: FileType, extension?: string): string {
    if (type === 'code' && extension) {
        return extension.toUpperCase();
    }

    const labels: Record<FileType, string> = {
        image: 'Image',
        code: 'Code',
        text: 'Text',
        markdown: 'Markdown',
        pdf: 'PDF',
        audio: 'Audio',
        video: 'Video',
        spreadsheet: 'Spreadsheet',
        csv: 'CSV',
        archive: 'Archive',
        database: 'Database',
        other: 'File'
    };

    return labels[type];
}

/**
 * Generate realistic file size estimate based on file path and type
 */
export function getFileSize(filepath: string, type: FileType): string {
    // Base size calculation
    const base = (filepath.length * 5) % 800 + 200;

    // Type-specific multipliers
    const multipliers: Record<FileType, number> = {
        image: 5.0,
        video: 20.0,
        audio: 10.0,
        code: 0.5,
        text: 0.3,
        markdown: 0.3,
        pdf: 8.0,
        spreadsheet: 3.0,
        csv: 2.0,
        archive: 5.0,
        database: 4.0,
        other: 1.0
    };

    const size = base * multipliers[type];

    if (size < 1024) return `${Math.round(size)} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get a normalized file path for content access.
 * Previously constructed sandbox API URLs — now just returns the normalized path.
 * Content is loaded via Runtime server's readFile() / useFileContent().
 */
export function getFileUrl(_sandboxId: string | undefined, path: string): string {
    // Handle paths that start with "workspace" (without leading /)
    if (path === 'workspace' || path.startsWith('workspace/')) {
        path = '/' + path;
    } else if (!path.startsWith('/workspace')) {
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

    return path;
}

/**
 * Extract filename from filepath
 */
export function getFilename(filepath: string): string {
    return filepath.split('/').pop() || 'file';
}
