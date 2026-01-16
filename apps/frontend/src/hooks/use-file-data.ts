/**
 * Unified file data hook
 * Handles all file types (image, PDF, XLSX, text) with a single interface
 */

import React from 'react';
import { useFileContentQuery } from './files/use-file-queries';
import { getFileType } from '@/lib/utils/file-utils';
import { isImageFile, isPdfExtension, isSpreadsheetExtension, isCsvExtension, isHtmlExtension, isMarkdownExtension, isJsonExtension, isVideoExtension, isTextExtension, isKanvaxExtension } from '@/lib/utils/file-types';

export interface UseFileDataOptions {
    enabled?: boolean;
    showPreview?: boolean;
}

export interface UseFileDataResult {
    // For images, PDFs, and videos: blob URL
    // For text files: string content
    data: string | null;
    isLoading: boolean;
    error: Error | null;
    retryCount: number;
    // Type-specific flags
    isImage: boolean;
    isPdf: boolean;
    isSpreadsheet: boolean;
    isVideo: boolean;
    isText: boolean;
}

/**
 * Unified hook for fetching file data
 * Handles sandbox connection waiting internally
 */
export function useFileData(
    sandboxId: string | undefined,
    filepath: string | undefined,
    options: UseFileDataOptions = {}
): UseFileDataResult {
    const { enabled = true, showPreview = true } = options;
    
    const filename = filepath ? filepath.split('/').pop() || '' : '';
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const fileType = filepath ? getFileType(filename) : 'other';
    
    // Determine what type of content we need
    const isImage = isImageFile(filepath || '');
    const isPdf = isPdfExtension(extension);
    const isSpreadsheet = isSpreadsheetExtension(extension);
    const isVideo = isVideoExtension(extension);
    const isCsv = isCsvExtension(extension);
    const isHtml = isHtmlExtension(extension);
    const isMarkdown = isMarkdownExtension(extension);
    const isJson = isJsonExtension(extension);
    const isPlainText = isTextExtension(extension);
    const isKanvax = isKanvaxExtension(extension);
    const isText = isHtml || isMarkdown || isJson || isCsv || isPlainText || isKanvax;
    
    // Determine content type for query
    const needsBlob = isImage || isPdf || isSpreadsheet || isVideo;
    const needsText = isText;
    
    // Fetch blob data for images, PDFs, spreadsheets
    const blobQuery = useFileContentQuery(
        needsBlob && showPreview ? sandboxId : undefined,
        needsBlob && showPreview ? filepath : undefined,
        {
            contentType: 'blob',
            enabled: enabled && needsBlob && showPreview,
        }
    );
    
    // Fetch text data for HTML, Markdown, JSON, CSV, TXT
    const textQuery = useFileContentQuery(
        needsText && showPreview ? sandboxId : undefined,
        needsText && showPreview ? filepath : undefined,
        {
            contentType: 'text',
            enabled: enabled && needsText && showPreview,
        }
    );
    
    // Convert blob to URL for images/PDFs
    const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
    
    React.useEffect(() => {
        if (blobQuery.data instanceof Blob) {
            const url = URL.createObjectURL(blobQuery.data);
            setBlobUrl(url);
            return () => {
                URL.revokeObjectURL(url);
                setBlobUrl(null);
            };
        } else {
            setBlobUrl(null);
        }
    }, [blobQuery.data]);
    
    // Determine which query to use
    const activeQuery = needsBlob ? blobQuery : textQuery;
    const data = needsBlob ? blobUrl : (textQuery.data as string | null);
    
    return {
        data,
        isLoading: activeQuery.isLoading,
        error: activeQuery.error as Error | null,
        retryCount: activeQuery.failureCount || 0,
        isImage,
        isPdf,
        isSpreadsheet,
        isVideo,
        isText,
    };
}

