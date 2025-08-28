import React from 'react';
import {
    FileText, FileImage, FileCode, FileSpreadsheet, FileVideo,
    FileAudio, FileType, Database, Archive, File, ExternalLink,
    Loader2, Download, ChevronDown
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AttachmentGroup } from './attachment-group';
import { HtmlRenderer } from './preview-renderers/html-renderer';
import { MarkdownRenderer } from './preview-renderers/markdown-renderer';
import { CsvRenderer } from './preview-renderers/csv-renderer';
import { XlsxRenderer } from './preview-renderers/xlsx-renderer';
import { PdfRenderer as PdfPreviewRenderer } from './preview-renderers/pdf-renderer';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

import { useFileContent, useImageContent } from '@/hooks/react-query/files';
import { useAuth } from '@/components/AuthProvider';
import { Project } from '@/lib/api';

// Define basic file types
export type FileType =
    | 'image' | 'code' | 'text' | 'pdf'
    | 'audio' | 'video' | 'spreadsheet'
    | 'archive' | 'database' | 'markdown'
    | 'csv'
    | 'other';

// Simple extension-based file type detection
function getFileType(filename: string): FileType {
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
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

// Get appropriate icon for file type
function getFileIcon(type: FileType): React.ElementType {
    const icons: Record<FileType, React.ElementType> = {
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

// Generate a human-readable display name for file type
function getTypeLabel(type: FileType, extension?: string): string {
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

// Generate realistic file size based on file path and type
function getFileSize(filepath: string, type: FileType): string {
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

// Get the API URL for file content
function getFileUrl(sandboxId: string | undefined, path: string): string {
    if (!sandboxId) return path;

    // Check if the path already starts with /workspace
    if (!path.startsWith('/workspace')) {
        // Prepend /workspace to the path if it doesn't already have it
        path = `/workspace/${path.startsWith('/') ? path.substring(1) : path}`;
    }

    // Handle any potential Unicode escape sequences
    try {
        // Replace escaped Unicode sequences with actual characters
        path = path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => {
            return String.fromCharCode(parseInt(hexCode, 16));
        });
    } catch (e) {
        console.error('Error processing Unicode escapes in path:', e);
    }

    const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`);

    // Properly encode the path parameter for UTF-8 support
    url.searchParams.append('path', path);

    return url.toString();
}

interface FileAttachmentProps {
    filepath: string;
    onClick?: (path: string) => void;
    className?: string;
    sandboxId?: string;
    showPreview?: boolean;
    localPreviewUrl?: string;
    customStyle?: React.CSSProperties;
    /**
     * Controls whether HTML, Markdown, and CSV files show their content preview.
     * - true: files are shown as regular file attachments (default)
     * - false: HTML, MD, and CSV files show rendered content in grid layout
     */
    collapsed?: boolean;
    project?: Project;
    isSingleItemGrid?: boolean; // New prop to detect single item in grid
    standalone?: boolean; // New prop for minimal standalone styling
    alignRight?: boolean; // New prop to control right alignment
}

// Cache fetched content between mounts to avoid duplicate fetches
// Content caches for file attachment optimization
// const contentCache = new Map<string, string>();
// const errorCache = new Set<string>();

export function FileAttachment({
    filepath,
    onClick,
    className,
    sandboxId,
    showPreview = true,
    localPreviewUrl,
    customStyle,
    collapsed = true,
    project,
    isSingleItemGrid = false,
    standalone = false,
    alignRight = false
}: FileAttachmentProps) {
    // Authentication 
    const { session } = useAuth();

    // Simplified state management
    const [hasError, setHasError] = React.useState(false);

    // XLSX sheet management
    const [xlsxSheetIndex, setXlsxSheetIndex] = React.useState(0);
    const [xlsxSheetNames, setXlsxSheetNames] = React.useState<string[]>([]);

    // Basic file info
    const filename = filepath.split('/').pop() || 'file';
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const fileType = getFileType(filename);
    const fileUrl = localPreviewUrl || (sandboxId ? getFileUrl(sandboxId, filepath) : filepath);
    const typeLabel = getTypeLabel(fileType, extension);
    const fileSize = getFileSize(filepath, fileType);
    const IconComponent = getFileIcon(fileType);

    // Display flags
    const isImage = fileType === 'image';
    const isHtmlOrMd = extension === 'html' || extension === 'htm' || extension === 'md' || extension === 'markdown';
    const isCsv = extension === 'csv' || extension === 'tsv';
    const isXlsx = extension === 'xlsx' || extension === 'xls';
    const isPdf = extension === 'pdf';
    const isGridLayout = customStyle?.gridColumn === '1 / -1' || Boolean(customStyle && ('--attachment-height' in customStyle));
    // Define isInlineMode early, before any hooks
    const isInlineMode = !isGridLayout;
    const shouldShowPreview = (isHtmlOrMd || isCsv || isXlsx || isPdf) && showPreview && collapsed === false;

    // Use the React Query hook to fetch file content
    // For CSV files, always try to load content for better preview experience
    // For XLSX files, we need binary data which is handled by useImageContent
    const shouldLoadContent = (isHtmlOrMd || isCsv) && (shouldShowPreview || isCsv);
    const {
        data: fileContent,
        isLoading: fileContentLoading,
        error: fileContentError
    } = useFileContent(
        shouldLoadContent ? sandboxId : undefined,
        shouldLoadContent ? filepath : undefined
    );

    // Use the React Query hook to fetch image content with authentication
    const {
        data: imageUrl,
        isLoading: imageLoading,
        error: imageError
    } = useImageContent(
        isImage && showPreview && sandboxId ? sandboxId : undefined,
        isImage && showPreview ? filepath : undefined
    );

    // For PDFs we also fetch blob URL via the same binary hook used for images
    const {
        data: pdfBlobUrl,
        isLoading: pdfLoading,
        error: pdfError
    } = useImageContent(
        isPdf && shouldShowPreview && sandboxId ? sandboxId : undefined,
        isPdf && shouldShowPreview ? filepath : undefined
    );

    // For XLSX files we fetch binary data and convert to base64
    const {
        data: xlsxBlobUrl,
        isLoading: xlsxLoading,
        error: xlsxError
    } = useImageContent(
        isXlsx && shouldShowPreview && sandboxId ? sandboxId : undefined,
        isXlsx && shouldShowPreview ? filepath : undefined
    );

    // Set error state based on query errors
    React.useEffect(() => {
        if (fileContentError || imageError || pdfError || xlsxError) {
            setHasError(true);
        }
    }, [fileContentError, imageError, pdfError, xlsxError]);

    // Parse XLSX to get sheet names when blob URL is available
    React.useEffect(() => {
        if (isXlsx && xlsxBlobUrl && shouldShowPreview) {
            const parseSheetNames = async () => {
                try {
                    // Import XLSX dynamically to avoid bundle size issues
                    const XLSX = await import('xlsx');

                    // Convert blob URL to binary data
                    const response = await fetch(xlsxBlobUrl);
                    const arrayBuffer = await response.arrayBuffer();

                    // Read workbook
                    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                    setXlsxSheetNames(workbook.SheetNames);
                } catch (error) {
                    console.error('Failed to parse XLSX sheet names:', error);
                    setXlsxSheetNames([]);
                }
            };

            parseSheetNames();
        }
    }, [isXlsx, xlsxBlobUrl, shouldShowPreview]);

    const handleClick = () => {
        if (onClick) {
            onClick(filepath);
        }
    };

    const handleDownload = async (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent triggering the main click handler

        try {
            if (!sandboxId || !session?.access_token) {
                // Fallback: open file URL in new tab
                window.open(fileUrl, '_blank');
                return;
            }

            // Use the same fetch logic as other components
            const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filepath)}`, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`
                }
            });

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Download failed:', error);
            // Fallback: try to open the file URL
            window.open(fileUrl, '_blank');
        }
    };

    // Images are displayed with their natural aspect ratio
    if (isImage && showPreview) {
        // Use custom height for images if provided through CSS variable
        const imageHeight = isGridLayout
            ? (customStyle as any)['--attachment-height'] as string
            : '54px';

        // Show loading state for images
        if (imageLoading && sandboxId) {
            return (
                <button
                    onClick={handleClick}
                    className={cn(
                        "group relative min-h-[54px] min-w-fit rounded-xl cursor-pointer",
                        "border border-black/10 dark:border-white/10",
                        "bg-black/5 dark:bg-black/20",
                        "p-0 overflow-hidden",
                        "flex items-center justify-center",
                        isGridLayout ? "w-full" : "min-w-[54px]",
                        className
                    )}
                    style={{
                        maxWidth: "100%",
                        height: isSingleItemGrid && isGridLayout ? 'auto' : (isGridLayout ? imageHeight : 'auto'),
                        maxHeight: isSingleItemGrid && isGridLayout ? '800px' : undefined,
                        minHeight: isGridLayout ? imageHeight : '54px',
                        ...customStyle
                    }}
                    title={filename}
                >
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="h-8 w-8 text-primary animate-spin" />
                    </div>
                </button>
            );
        }

        // Check for errors
        if (imageError || hasError) {
            return (
                <button
                    onClick={handleClick}
                    className={cn(
                        "group relative min-h-[54px] min-w-fit rounded-xl cursor-pointer",
                        "border border-black/10 dark:border-white/10",
                        "bg-black/5 dark:bg-black/20",
                        "p-0 overflow-hidden",
                        "flex flex-col items-center justify-center gap-1",
                        isGridLayout ? "w-full" : "inline-block",
                        className
                    )}
                    style={{
                        maxWidth: "100%",
                        height: isSingleItemGrid && isGridLayout ? 'auto' : (isGridLayout ? imageHeight : 'auto'),
                        maxHeight: isSingleItemGrid && isGridLayout ? '800px' : undefined,
                        ...customStyle
                    }}
                    title={filename}
                >
                    <IconComponent className="h-6 w-6 text-red-500 mb-1" />
                    <div className="text-xs text-red-500">Failed to load image</div>
                </button>
            );
        }

        return (
            <button
                onClick={handleClick}
                className={cn(
                    "group relative min-h-[54px] rounded-2xl cursor-pointer",
                    "border border-black/10 dark:border-white/10",
                    "bg-black/5 dark:bg-black/20",
                    "p-0 overflow-hidden", // No padding, content touches borders
                    "flex items-center justify-center", // Center the image
                    isGridLayout ? "w-full" : "inline-block", // Full width in grid
                    className
                )}
                style={{
                    maxWidth: "100%", // Ensure doesn't exceed container width
                    height: isSingleItemGrid && isGridLayout ? 'auto' : (isGridLayout ? imageHeight : 'auto'),
                    maxHeight: isSingleItemGrid && isGridLayout ? '800px' : undefined,
                    ...customStyle
                }}
                title={filename}
            >
                <img
                    src={sandboxId && session?.access_token ? imageUrl : (fileUrl || '')}
                    alt={filename}
                    className={cn(
                        "max-h-full max-w-full", // Respect parent constraints
                        isSingleItemGrid ? "object-contain" : isGridLayout ? "w-full h-full object-cover" : "w-auto"
                    )}
                    style={{
                        height: isSingleItemGrid ? 'auto' : imageHeight,
                        objectPosition: "center",
                        objectFit: isSingleItemGrid ? "contain" : isGridLayout ? "cover" : "contain"
                    }}
                    onLoad={() => {
                    }}
                    onError={(e) => {
                        // Avoid logging the error for all instances of the same image
                        console.error('Image load error for:', filename);

                        // Only log details in dev environments to avoid console spam
                        if (process.env.NODE_ENV === 'development') {
                            const imgSrc = sandboxId && session?.access_token ? imageUrl : fileUrl;
                            console.error('Image URL:', imgSrc);

                            // Additional debugging for blob URLs
                            if (typeof imgSrc === 'string' && imgSrc.startsWith('blob:')) {
                                console.error('Blob URL failed to load. This could indicate:');
                                console.error('- Blob URL was revoked prematurely');
                                console.error('- Blob data is corrupted or invalid');
                                console.error('- MIME type mismatch');

                                // Try to check if the blob URL is still valid
                                fetch(imgSrc, { method: 'HEAD' })
                                    .then(response => {
                                        console.error(`Blob URL HEAD request status: ${response.status}`);
                                        console.error(`Blob URL content type: ${response.headers.get('content-type')}`);
                                    })
                                    .catch(err => {
                                        console.error('Blob URL HEAD request failed:', err.message);
                                    });
                            }

                            // Check if the error is potentially due to authentication
                            if (sandboxId && (!session || !session.access_token)) {
                                console.error('Authentication issue: Missing session or token');
                            }
                        }

                        setHasError(true);
                        // If the image failed to load and we have a localPreviewUrl that's a blob URL, try using it directly
                        if (localPreviewUrl && typeof localPreviewUrl === 'string' && localPreviewUrl.startsWith('blob:')) {
                            (e.target as HTMLImageElement).src = localPreviewUrl;
                        }
                    }}
                />
            </button>
        );
    }

    const rendererMap = {
        'html': HtmlRenderer,
        'htm': HtmlRenderer,
        'md': MarkdownRenderer,
        'markdown': MarkdownRenderer,
        'csv': CsvRenderer,
        'tsv': CsvRenderer,
        'xlsx': XlsxRenderer,
        'xls': XlsxRenderer
    };

    // HTML/MD/CSV/PDF preview when not collapsed and in grid layout
    if (shouldShowPreview && isGridLayout) {
        // Determine the renderer component
        const Renderer = rendererMap[extension as keyof typeof rendererMap];

        return (
            <div
                className={cn(
                    "group relative w-full",
                    "rounded-xl border bg-card overflow-hidden pt-10", // Consistent card styling with header space
                    isPdf ? "!min-h-[200px] sm:min-h-0 sm:h-[400px] max-h-[500px] sm:!min-w-[300px]" :
                        isHtmlOrMd ? "!min-h-[200px] sm:min-h-0 sm:h-[400px] max-h-[600px] sm:!min-w-[300px]" :
                            (isCsv || isXlsx) ? "min-h-[300px] h-full" : // Let CSV and XLSX take full height
                                standalone ? "min-h-[300px] h-auto" : "h-[300px]", // Better height handling for standalone
                    className
                )}
                style={{
                    gridColumn: "1 / -1", // Make it take full width in grid
                    width: "100%",        // Ensure full width
                    minWidth: 0,          // Prevent flex shrinking issues
                    ...customStyle
                }}
                onClick={hasError ? handleClick : undefined} // Make clickable if error
            >
                {/* Content area */}
                <div
                    className="h-full w-full relative"
                    style={{
                        minWidth: 0,
                        width: '100%',
                        containIntrinsicSize: (isPdf || isHtmlOrMd) ? '100% 500px' : undefined,
                        contain: (isPdf || isHtmlOrMd) ? 'layout size' : undefined
                    }}
                >
                    {/* Render PDF, XLSX, or text-based previews */}
                    {!hasError && (
                        <>
                            {isPdf && (() => {
                                const pdfUrlForRender = localPreviewUrl || (sandboxId ? (pdfBlobUrl ?? null) : fileUrl);
                                return pdfUrlForRender ? (
                                    <PdfPreviewRenderer
                                        url={pdfUrlForRender}
                                        className="h-full w-full"
                                    />
                                ) : null;
                            })()}
                            {isXlsx && (() => {
                                const xlsxUrlForRender = localPreviewUrl || (sandboxId ? (xlsxBlobUrl ?? null) : fileUrl);
                                return xlsxUrlForRender ? (
                                    <XlsxRenderer
                                        content={xlsxUrlForRender}
                                        className="h-full w-full"
                                        activeSheetIndex={xlsxSheetIndex}
                                        onSheetChange={(index) => setXlsxSheetIndex(index)}
                                    />
                                ) : null;
                            })()}
                            {!isPdf && !isXlsx && fileContent && Renderer && (
                                <Renderer
                                    content={fileContent}
                                    previewUrl={fileUrl}
                                    className="h-full w-full"
                                    project={project}
                                />
                            )}
                        </>
                    )}

                    {/* Error state */}
                    {hasError && (
                        <div className="h-full w-full flex flex-col items-center justify-center p-4">
                            <div className="text-red-500 mb-2">Error loading content</div>
                            <div className="text-muted-foreground text-sm text-center mb-2">
                                {fileUrl && (
                                    <div className="text-xs max-w-full overflow-hidden truncate opacity-70">
                                        Path may need /workspace prefix
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleDownload}
                                    className="px-3 py-1.5 bg-secondary/10 hover:bg-secondary/20 rounded-md text-sm flex items-center gap-1"
                                >
                                    <Download size={14} />
                                    Download
                                </button>
                                <button
                                    onClick={handleClick}
                                    className="px-3 py-1.5 bg-primary/10 hover:bg-primary/20 rounded-md text-sm flex items-center gap-1"
                                >
                                    <ExternalLink size={14} />
                                    Open in viewer
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Loading state */}
                    {fileContentLoading && !isPdf && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
                            <Loader2 className="h-8 w-8 text-primary animate-spin" />
                        </div>
                    )}

                    {isPdf && pdfLoading && !pdfBlobUrl && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
                            <Loader2 className="h-8 w-8 text-primary animate-spin" />
                        </div>
                    )}

                    {isXlsx && xlsxLoading && !xlsxBlobUrl && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
                            <Loader2 className="h-8 w-8 text-primary animate-spin" />
                        </div>
                    )}

                    {/* Empty content state - show when not loading and no content yet */}
                    {!isPdf && !isXlsx && !fileContent && !fileContentLoading && !hasError && (
                        <div className="h-full w-full flex flex-col items-center justify-center p-4 pointer-events-none">
                            <div className="text-muted-foreground text-sm mb-2">
                                Preview available
                            </div>
                            <div className="text-muted-foreground text-xs text-center">
                                Click header to open externally
                            </div>
                        </div>
                    )}
                </div>

                {/* Header with filename */}
                <div className="absolute top-0 left-0 right-0 bg-accent p-2 h-[40px] z-10 flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="text-sm font-medium truncate">{filename}</div>
                        {/* XLSX Sheet Selector */}
                        {isXlsx && xlsxSheetNames.length > 1 && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button className="flex items-center gap-1 px-2 py-1 rounded-xl hover:bg-background/70 text-xs font-medium transition-colors">
                                        <span className="truncate max-w-[100px]">{xlsxSheetNames[xlsxSheetIndex] || 'Sheet 1'}</span>
                                        <ChevronDown size={12} />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="min-w-[120px]">
                                    {xlsxSheetNames.map((sheetName, index) => (
                                        <DropdownMenuItem
                                            key={index}
                                            onClick={() => setXlsxSheetIndex(index)}
                                            className={cn(
                                                "text-xs cursor-pointer",
                                                index === xlsxSheetIndex && "bg-accent"
                                            )}
                                        >
                                            {sheetName}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        {/* <button
                            onClick={handleDownload}
                            className="cursor-pointer p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                            title="Download file"
                        >
                            <Download size={14} />
                        </button> */}
                        {onClick && (
                            <button
                                onClick={handleClick}
                                className="cursor-pointer p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                                title="Open in viewer"
                            >
                                <ExternalLink size={14} />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // Regular files with details
    const safeStyle = { ...customStyle };
    delete safeStyle.height;
    delete (safeStyle as any)['--attachment-height'];

    const fileButton = (
        <button
            onClick={handleClick}
            className={cn(
                "group flex rounded-xl transition-all duration-200 min-h-[54px] h-[54px] overflow-hidden cursor-pointer",
                "border border-black/10 dark:border-white/10",
                "bg-sidebar",
                "text-left",
                "pr-7", // Right padding for X button
                isInlineMode
                    ? "min-w-[170px] w-full sm:max-w-[300px] sm:w-fit" // Full width on mobile, constrained on larger screens
                    : "min-w-[170px] max-w-[300px] w-fit", // Original constraints for grid layout
                className
            )}
            style={safeStyle}
            title={filename}
        >
            <div className="relative min-w-[54px] w-[54px] h-full aspect-square flex-shrink-0 bg-black/5 dark:bg-white/5">
                <div className="flex items-center justify-center h-full w-full">
                    <IconComponent className="h-5 w-5 text-black/60 dark:text-white/60" />
                </div>
            </div>

            <div className="flex-1 min-w-0 flex flex-col justify-center p-2 pl-3 overflow-hidden">
                <div className="text-sm font-medium text-foreground truncate max-w-full">
                    {filename}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                    <span className="text-black/60 dark:text-white/60 truncate">{typeLabel}</span>
                    <span className="text-black/40 dark:text-white/40 flex-shrink-0">·</span>
                    <span className="text-black/60 dark:text-white/60 flex-shrink-0">{fileSize}</span>
                </div>
            </div>
        </button>
    );

    // Wrap with alignment container if alignRight is true
    if (alignRight) {
        return (
            <div className="w-full flex justify-end">
                <div className="max-w-[85%]">
                    {fileButton}
                </div>
            </div>
        );
    }

    return fileButton;
}

interface FileAttachmentGridProps {
    attachments: string[];
    onFileClick?: (path: string, filePathList?: string[]) => void;
    className?: string;
    sandboxId?: string;
    showPreviews?: boolean;
    collapsed?: boolean;
    project?: Project;
    standalone?: boolean;
    alignRight?: boolean;
}

export function FileAttachmentGrid({
    attachments,
    onFileClick,
    className,
    sandboxId,
    showPreviews = true,
    collapsed = false,
    project,
    standalone = false,
    alignRight = false
}: FileAttachmentGridProps) {
    if (!attachments || attachments.length === 0) return null;

    // For standalone rendering, always expand previews to show content
    const shouldCollapse = standalone ? false : collapsed;

    const content = (
        <AttachmentGroup
            files={attachments}
            onFileClick={onFileClick}
            className={className}
            sandboxId={sandboxId}
            showPreviews={showPreviews}
            layout="grid"
            gridImageHeight={standalone ? 500 : 150} // Larger height for standalone files
            collapsed={shouldCollapse}
            project={project}
            standalone={standalone}
            alignRight={alignRight}
        />
    );

    // Wrap with alignment container if alignRight is true
    if (alignRight) {
        return (
            <div className="w-full flex justify-end">
                <div className="max-w-[85%]">
                    {content}
                </div>
            </div>
        );
    }

    return content;
} 