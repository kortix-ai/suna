import { useTranslations } from 'next-intl';
/**
 * FileAttachment - Main file attachment component
 * Simplified: uses GridFileCard (FileThumbnail) for all file types.
 * Click-to-open is handled by the parent via onClick.
 */

import React from 'react';
import { cn } from '@/lib/utils';
import { GridFileCard } from './GridFileCard';
import { getFilename } from '@/lib/utils/file-utils';
import { Project } from '@/types/project';
import { PresentationSlidePreview } from '@/components/thread/tool-views/presentation-tools/PresentationSlidePreview';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';
import { IframePreview } from '../iframe-preview';

// Helper function to check if a filepath is a presentation attachment
function isPresentationAttachment(filepath: string): boolean {
    const presentationPattern = /presentations\/([^\/]+)\/slide_(\d+)\.html$/i;
    return presentationPattern.test(filepath);
}

function extractPresentationName(filepath: string): string | null {
    const match = filepath.match(/presentations\/([^\/]+)\/slide_\d+\.html$/i);
    return match ? match[1] : null;
}

function extractSlideNumber(filepath: string): number | null {
    const match = filepath.match(/slide_(\d+)\.html$/i);
    return match ? parseInt(match[1], 10) : null;
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
    project,
    alignRight = false,
}: FileAttachmentProps) {
    const { openPresentation } = usePresentationViewerStore();
    const filename = getFilename(filepath);

    const handleClick = () => {
        if (onClick) {
            onClick(filepath);
        }
    };

    // Presentation attachments get special rendering
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
                            project.sandbox.sandbox_url!,
                            slideNum || slideNumber || 1
                        );
                    }}
                    className={className}
                />
            );
        }
    }

    // All other files: render a GridFileCard
    const card = (
        <GridFileCard
            filePath={filepath}
            fileName={filename}
            onClick={handleClick}
            className={className}
        />
    );

    if (alignRight) {
        return (
            <div className="w-full flex justify-end">
                <div className="max-w-[85%]">
                    {card}
                </div>
            </div>
        );
    }

    return card;
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
    localPreviewUrls?: Record<string, string>;
}

function isUrl(str: string): boolean {
    return str.startsWith('http://') || str.startsWith('https://');
}

function isImageUrl(url: string): boolean {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.heif', '.avif'];
        return imageExtensions.some(ext => pathname.endsWith(ext));
    } catch {
        return false;
    }
}

export function FileAttachmentGrid({
    attachments,
    onFileClick,
    className,
    project,
    standalone = false,
    alignRight = false,
}: FileAttachmentGridProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
    if (!attachments || attachments.length === 0) return null;

    // Separate URLs from file paths
    const urls = attachments.filter(isUrl);
    const filePaths = attachments.filter(att => !isUrl(att));

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
                        if (isImageUrl(url)) {
                            let imageName = '';
                            try {
                                const urlObj = new URL(url);
                                const pathname = urlObj.pathname;
                                imageName = pathname.split('/').pop() || '';
                                imageName = decodeURIComponent(imageName).replace(/[_-]/g, ' ');
                            } catch {
                                // Keep empty if parsing fails
                            }

                            return (
                                <span key={`url-${index}`} className="block my-5">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={url}
                                        alt={imageName}
                                        className={cn(
                                            "max-w-full h-auto rounded-xl",
                                            "border border-border/40",
                                        )}
                                        loading="lazy"
                                    />
                                    {imageName && (
                                        <span className="block mt-2 text-center text-sm text-muted-foreground">
                                            {imageName}
                                        </span>
                                    )}
                                </span>
                            );
                        }

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
                                    "group relative w-full col-span-full min-w-0",
                                    "rounded-2xl border bg-card overflow-hidden pt-10",
                                    standalone ? "min-h-[300px] h-[400px]" : "!min-h-[200px] sm:min-h-0 sm:h-[400px] max-h-[600px] sm:!min-w-[300px]"
                                )}
                            >
                                <div
                                    className="h-full w-full relative min-w-0"
                                    style={{
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
                                        title={tHardcodedUi.raw('componentsThreadFileAttachmentIndex.line233JsxAttrTitleOpenInNewTab')}
                                    >
                                        <svg className="h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Render file attachments as grid of GridFileCards */}
            {filePaths.length > 0 && (
                <div className={cn("flex flex-wrap gap-3", className)}>
                    {filePaths.map((filepath, index) => (
                        <FileAttachment
                            key={index}
                            filepath={filepath}
                            onClick={() => handleFileClick(filepath)}
                            project={project}
                        />
                    ))}
                </div>
            )}
        </div>
    );

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
