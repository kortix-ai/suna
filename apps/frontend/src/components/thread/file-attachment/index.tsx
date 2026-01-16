/**
 * FileAttachment - Main file attachment component
 * Clean, focused implementation using separated preview components
 */

import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileCard } from '@/components/file-previews/FileCard';
import { ImagePreview } from '@/components/file-previews/ImagePreview';
import { PdfPreview } from '@/components/file-previews/PdfPreview';
import { SpreadsheetPreview } from '@/components/file-previews/SpreadsheetPreview';
import { DocumentPreview } from '@/components/file-previews/DocumentPreview';
import { KanvaxPreview } from '@/components/file-previews/KanvaxPreview';
import { FileCarousel } from '@/components/file-layouts/FileCarousel';
import { FileGrid } from '@/components/file-layouts/FileGrid';
import { useFileData } from '@/hooks/use-file-data';
import { getFileType, getFilename } from '@/lib/utils/file-utils';
import { isImageFile, isPdfExtension, isSpreadsheetExtension, isCsvExtension, isPreviewableFile, isKanvaxFile } from '@/lib/utils/file-types';
import { Project } from '@/lib/api/threads';
import { PresentationSlidePreview } from '@/components/thread/tool-views/presentation-tools/PresentationSlidePreview';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';
import { IframePreview } from '../iframe-preview';

// Helper function to check if a filepath is a presentation attachment
// Matches paths like: presentations/name/slide_01.html, /workspace/presentations/name/slide_01.html, etc.
function isPresentationAttachment(filepath: string): boolean {
    const presentationPattern = /presentations\/([^\/]+)\/slide_(\d+)\.html$/i;
    return presentationPattern.test(filepath);
}

// Helper function to extract presentation name from filepath
function extractPresentationName(filepath: string): string | null {
    const match = filepath.match(/presentations\/([^\/]+)\/slide_\d+\.html$/i);
    return match ? match[1] : null;
}

// Helper function to extract slide number from filepath
function extractSlideNumber(filepath: string): number | null {
    const match = filepath.match(/slide_(\d+)\.html$/i);
    if (match) {
        return parseInt(match[1], 10);
    }
    return null;
}

export interface FileAttachmentProps {
    filepath: string;
    onClick?: (path: string) => void;
    className?: string;
    sandboxId?: string;
    showPreview?: boolean;
    localPreviewUrl?: string;
    customStyle?: React.CSSProperties;
    collapsed?: boolean;
    project?: Project;
    isSingleItemGrid?: boolean;
    standalone?: boolean;
    alignRight?: boolean;
    uploadStatus?: 'pending' | 'uploading' | 'ready' | 'error';
}

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
    alignRight = false,
    uploadStatus,
}: FileAttachmentProps) {
    const { openPresentation } = usePresentationViewerStore();
    const filename = getFilename(filepath);
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const fileType = getFileType(filename);
    
    // Determine file characteristics
    const isImage = isImageFile(filepath);
    const isPdf = isPdfExtension(extension);
    const isSpreadsheet = isSpreadsheetExtension(extension) || isCsvExtension(extension);
    const isKanvax = isKanvaxFile(filepath);
    const isPreviewable = isPreviewableFile(filepath);
    const isGridLayout = customStyle?.gridColumn === '1 / -1' || Boolean(customStyle && ('--attachment-height' in customStyle));
    // Images should also show previews, not just previewable files
    const shouldShowPreview = (isPreviewable || isImage) && showPreview && collapsed === false;
    
    // Call all hooks at the top level before any early returns
    const { error, retryCount } = useFileData(
        sandboxId,
        filepath,
        { enabled: shouldShowPreview, showPreview: shouldShowPreview }
    );
    
    const { data, isLoading } = useFileData(
        sandboxId,
        filepath,
        { enabled: shouldShowPreview, showPreview: true }
    );
    
    const isSandboxDeleted = error?.message?.includes('404') || 
                             error?.message?.includes('Sandbox not found') ||
                             error?.message?.includes('no project owns this sandbox');
    const isStillRetrying = retryCount < 15;
    const hasError = error && !isStillRetrying;
    const hasContent = data || localPreviewUrl;
    // For images, we have content if we have localPreviewUrl
    const waitingForSandbox = (isPdf || isSpreadsheet || isPreviewable) && !sandboxId && !localPreviewUrl;
    
    const handleClick = () => {
        if (onClick) {
            onClick(filepath);
        }
    };
    
    // Check for presentation attachments
    if (isPresentationAttachment(filepath) && project) {
        const presentationName = extractPresentationName(filepath);
        const slideNumber = extractSlideNumber(filepath);
        if (presentationName && project?.sandbox?.sandbox_url) {
            return (
                <PresentationSlidePreview
                    presentationName={presentationName}
                    project={project}
                    initialSlide={slideNumber || undefined}
                    onFullScreenClick={(slideNum) => {
                        openPresentation(
                            presentationName,
                            project.sandbox.sandbox_url,
                            slideNum || slideNumber || 1
                        );
                    }}
                    className={className}
                />
            );
        }
    }
    
    // Show compact FileCard when collapsed or not in grid layout
    if (collapsed || !isGridLayout) {
        // For images, always show preview in grid layout (even when collapsed prop is true)
        if (isImage && isGridLayout && showPreview) {
            return (
                <ImagePreview
                    filepath={filepath}
                    sandboxId={sandboxId}
                    localPreviewUrl={localPreviewUrl}
                    onClick={handleClick}
                    className={className}
                    customStyle={customStyle}
                    uploadStatus={uploadStatus}
                    isGridLayout={isGridLayout}
                />
            );
        }

        // For kanvax, show preview in grid layout when we have localPreviewUrl or sandboxId
        if (isKanvax && isGridLayout && showPreview && (localPreviewUrl || sandboxId)) {
            return (
                <div
                    className={cn(
                        "group relative w-full rounded-xl border bg-card overflow-hidden",
                        "aspect-[4/3] min-h-[200px]",
                        className
                    )}
                    style={customStyle}
                >
                    <KanvaxPreview
                        filepath={filepath}
                        sandboxId={sandboxId}
                        localPreviewUrl={localPreviewUrl}
                        className="h-full w-full"
                    />
                </div>
            );
        }

        // Otherwise show compact FileCard
        return (
            <FileCard
                filepath={filepath}
                onClick={handleClick}
                className={className}
                uploadStatus={uploadStatus}
                isLoading={shouldShowPreview && retryCount < 15 && !isKanvax}
                hasError={hasError}
                isSandboxDeleted={isSandboxDeleted}
                alignRight={alignRight}
            />
        );
    }
    
    // Large preview layout - only show when content is loaded
    // For images/kanvax with localPreviewUrl, always show preview even if shouldShowPreview is false
    const canShowPreview = shouldShowPreview || ((isImage || isKanvax) && localPreviewUrl);
    
    // Kanvax handles its own loading state internally, so skip content check for it
    const needsContentCheck = !isKanvax && !isImage;
    if (!canShowPreview || waitingForSandbox || hasError || isSandboxDeleted || (needsContentCheck && !hasContent && !localPreviewUrl)) {
        return (
            <FileCard
                filepath={filepath}
                onClick={handleClick}
                className={className}
                uploadStatus={uploadStatus}
                isLoading={isLoading && !isKanvax}
                hasError={hasError}
                isSandboxDeleted={isSandboxDeleted}
                alignRight={alignRight}
            />
        );
    }
    
    // Render appropriate preview component
    return (
        <div
            className={cn(
                "group relative w-full",
                "rounded-xl border bg-card overflow-hidden pt-10",
                isPdf ? "!min-h-[200px] sm:min-h-0 sm:h-[400px] max-h-[500px] sm:!min-w-[300px]" :
                    isPreviewable ? "!min-h-[200px] sm:min-h-0 sm:h-[400px] max-h-[600px] sm:!min-w-[300px]" :
                        standalone ? "min-h-[300px] h-auto" : "h-[300px]",
                className
            )}
            style={{
                gridColumn: "1 / -1",
                width: "100%",
                minWidth: 0,
                ...customStyle
            }}
            onClick={hasError && !isSandboxDeleted ? handleClick : undefined}
        >
            {/* Content area */}
            <div
                className="h-full w-full relative"
                style={{
                    minWidth: 0,
                    width: '100%',
                    containIntrinsicSize: (isPdf || isPreviewable) ? '100% 500px' : undefined,
                    contain: (isPdf || isPreviewable) ? 'layout size' : undefined
                }}
            >
                {!hasError && !isSandboxDeleted && (
                    <>
                        {isImage && (
                            <ImagePreview
                                filepath={filepath}
                                sandboxId={sandboxId}
                                localPreviewUrl={localPreviewUrl}
                                onClick={handleClick}
                                className="h-full w-full"
                                customStyle={customStyle}
                                uploadStatus={uploadStatus}
                                isGridLayout={true}
                            />
                        )}
                        
                        {isPdf && (
                            <PdfPreview
                                filepath={filepath}
                                sandboxId={sandboxId}
                                localPreviewUrl={localPreviewUrl}
                                className="h-full w-full"
                            />
                        )}
                        
                        {isSpreadsheet && (
                            <SpreadsheetPreview
                                filepath={filepath}
                                sandboxId={sandboxId}
                                project={project}
                                className="h-full w-full"
                            />
                        )}
                        
                        {isKanvax && (
                            <KanvaxPreview
                                filepath={filepath}
                                sandboxId={sandboxId}
                                localPreviewUrl={localPreviewUrl}
                                className="h-full w-full"
                            />
                        )}

                        {isPreviewable && !isImage && !isPdf && !isSpreadsheet && !isKanvax && (
                            <DocumentPreview
                                filepath={filepath}
                                sandboxId={sandboxId}
                                project={project}
                                className="h-full w-full"
                            />
                        )}
                    </>
                )}
            </div>
            
            {/* Header with filename */}
            <div className="absolute top-0 left-0 right-0 bg-accent p-2 h-[40px] z-10 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="text-sm font-medium truncate">{filename}</div>
                </div>
                <div className="flex items-center gap-1">
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

// FileAttachmentGrid component for multiple files
export interface FileAttachmentGridProps {
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

// Helper function to check if a string is a URL
function isUrl(str: string): boolean {
    return str.startsWith('http://') || str.startsWith('https://');
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
    alignRight = false,
}: FileAttachmentGridProps) {
    // Call hooks at the top level before any early returns
    const [currentIndex, setCurrentIndex] = useState(0);
    
    if (!attachments || attachments.length === 0) return null;
    
    // Separate URLs from file paths
    const urls = attachments.filter(isUrl);
    const filePaths = attachments.filter(att => !isUrl(att));
    
    // Always show previews for grid layout
    const shouldCollapse = false;
    
    // Calculate grid image height
    const getGridImageHeight = () => {
        if (!standalone) return 200;
        const fileCount = filePaths.length;
        if (fileCount === 1) return 600;
        if (fileCount === 2) return 400;
        if (fileCount <= 4) return 300;
        return 250;
    };
    
    const gridImageHeight = getGridImageHeight();
    
    // Use carousel for 2+ files
    const shouldUseCarousel = filePaths.length >= 2;
    
    const handleFileClick = (path: string) => {
        if (onFileClick) {
            onFileClick(path, filePaths);
        }
    };
    
    const content = (
        <div className="space-y-4">
            {/* Render URL previews */}
            {urls.length > 0 && (
                <div className="space-y-3">
                    {urls.map((url, index) => {
                        let domain = url;
                        try {
                            const urlObj = new URL(url);
                            domain = urlObj.hostname;
                        } catch {
                            // Keep original URL if parsing fails
                        }
                        
                        return (
                            <div
                                key={`url-${index}`}
                                className={cn(
                                    "group relative w-full",
                                    "rounded-xl border bg-card overflow-hidden pt-10",
                                    standalone ? "min-h-[300px] h-[400px]" : "!min-h-[200px] sm:min-h-0 sm:h-[400px] max-h-[600px] sm:!min-w-[300px]"
                                )}
                                style={{
                                    gridColumn: "1 / -1",
                                    width: "100%",
                                    minWidth: 0
                                }}
                            >
                                {/* URL preview */}
                                <div
                                    className="h-full w-full relative"
                                    style={{
                                        minWidth: 0,
                                        width: '100%',
                                        containIntrinsicSize: '100% 500px',
                                        contain: 'layout size'
                                    }}
                                >
                                    <IframePreview
                                        url={url}
                                        title={`Preview: ${domain}`}
                                    />
                                </div>
                                <div className="absolute top-0 left-0 right-0 bg-accent p-2 h-[40px] z-10 flex items-center justify-between">
                                    <div className="text-sm font-medium truncate" title={url}>
                                        {domain}
                                    </div>
                                    <button
                                        onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                                        className="cursor-pointer p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                                        title="Open in new tab"
                                    >
                                        <svg className="h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            
            {/* Render file attachments */}
            {filePaths.length > 0 && (
                <>
                    {shouldUseCarousel ? (
                        <FileCarousel
                            files={filePaths}
                            currentIndex={currentIndex}
                            onIndexChange={setCurrentIndex}
                            className={className}
                        >
                            {(filepath, index) => (
                                <FileAttachment
                                    filepath={filepath}
                                    onClick={() => handleFileClick(filepath)}
                                    sandboxId={sandboxId}
                                    showPreview={showPreviews}
                                    collapsed={shouldCollapse}
                                    project={project}
                                    isSingleItemGrid={filePaths.length === 1}
                                    standalone={standalone}
                                    alignRight={alignRight}
                                    customStyle={
                                        isImageFile(filepath) ? {
                                            width: '100%',
                                            height: 'auto',
                                            maxHeight: `${gridImageHeight}px`,
                                            '--attachment-height': `${gridImageHeight}px`
                                        } as React.CSSProperties : isPreviewableFile(filepath) ? {
                                            gridColumn: '1 / -1',
                                            width: '100%'
                                        } : undefined
                                    }
                                />
                            )}
                        </FileCarousel>
                    ) : (
                        <FileGrid files={filePaths} className={className}>
                            {(filepath, index) => (
                                <FileAttachment
                                    filepath={filepath}
                                    onClick={() => handleFileClick(filepath)}
                                    sandboxId={sandboxId}
                                    showPreview={showPreviews}
                                    collapsed={shouldCollapse}
                                    project={project}
                                    isSingleItemGrid={filePaths.length === 1}
                                    standalone={standalone}
                                    alignRight={alignRight}
                                    customStyle={
                                        isImageFile(filepath) ? {
                                            width: '100%',
                                            height: 'auto',
                                            maxHeight: `${gridImageHeight}px`,
                                            '--attachment-height': `${gridImageHeight}px`
                                        } as React.CSSProperties : isPreviewableFile(filepath) ? {
                                            gridColumn: '1 / -1',
                                            width: '100%'
                                        } : undefined
                                    }
                                />
                            )}
                        </FileGrid>
                    )}
                </>
            )}
        </div>
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

// Export AttachmentGroup for backward compatibility
export { AttachmentGroup } from './AttachmentGroup';

