/**
 * FileCard - Compact file display component
 * Always renders immediately, shows file info without waiting for content
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getFileType, getFileIcon, getTypeLabel, getFileSize, getFilename } from '@/lib/utils/file-utils';

export interface FileCardProps {
    filepath: string;
    onClick?: () => void;
    className?: string;
    uploadStatus?: 'pending' | 'uploading' | 'ready' | 'error';
    isLoading?: boolean;
    hasError?: boolean;
    isSandboxDeleted?: boolean;
    alignRight?: boolean;
}

export function FileCard({
    filepath,
    onClick,
    className,
    uploadStatus,
    isLoading = false,
    hasError = false,
    isSandboxDeleted = false,
    alignRight = false,
}: FileCardProps) {
    const filename = getFilename(filepath);
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const fileType = getFileType(filename);
    const typeLabel = getTypeLabel(fileType, extension);
    const fileSize = getFileSize(filepath, fileType);
    const IconComponent = getFileIcon(fileType);

    // Show sandbox deleted state
    if (isSandboxDeleted) {
        return (
            <div
                className={cn(
                    "group flex items-center rounded-xl transition-all duration-200 overflow-hidden cursor-not-allowed",
                    "border border-border/50",
                    "bg-muted/30 opacity-50",
                    "text-left",
                    "h-[54px] w-fit min-w-[200px] max-w-[300px]",
                    className
                )}
                title={`${filename} - Sandbox no longer available`}
            >
                <div className="w-[54px] h-full flex items-center justify-center flex-shrink-0 bg-muted/50">
                    <IconComponent className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0 flex flex-col justify-center px-3 py-2 overflow-hidden">
                    <div className="text-sm font-medium text-muted-foreground truncate">
                        {filename}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                        <span className="truncate">Unavailable</span>
                        <span className="flex-shrink-0">·</span>
                        <span className="flex-shrink-0">Sandbox deleted</span>
                    </div>
                </div>
            </div>
        );
    }

    // Regular file card
    const card = (
        <button
            onClick={uploadStatus === 'uploading' ? undefined : onClick}
            className={cn(
                "group flex items-center rounded-xl transition-all duration-200 overflow-hidden",
                uploadStatus === 'uploading' ? "cursor-default" : "cursor-pointer",
                "border border-black/10 dark:border-white/10",
                uploadStatus === 'error' || hasError
                    ? "bg-red-500/5 border-red-500/20" 
                    : "bg-sidebar hover:bg-accent/5",
                "text-left",
                "h-[54px] w-fit min-w-[200px] max-w-[300px]",
                className
            )}
            title={
                uploadStatus === 'uploading' ? 'Uploading...' : 
                uploadStatus === 'error' ? 'Upload failed' : 
                hasError ? 'Failed to load - Click to open' : 
                isLoading ? 'Loading...' : 
                filename
            }
        >
            {/* Icon container with loading overlay */}
            <div className="w-[54px] h-full flex items-center justify-center flex-shrink-0 bg-black/5 dark:bg-white/5 relative">
                <IconComponent className={cn(
                    "h-5 w-5",
                    uploadStatus === 'error' || hasError ? "text-red-500" : "text-black/60 dark:text-white/60"
                )} />
                {(uploadStatus === 'uploading' || isLoading) && !hasError && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                        <Loader2 className="h-4 w-4 text-white animate-spin" />
                    </div>
                )}
            </div>

            {/* Text content */}
            <div className="flex-1 min-w-0 flex flex-col justify-center px-3 py-2 overflow-hidden">
                <div className={cn(
                    "text-sm font-medium truncate",
                    uploadStatus === 'error' || hasError ? "text-red-500" : "text-foreground"
                )}>
                    {filename}
                </div>
                <div className={cn(
                    "text-xs flex items-center gap-1 truncate",
                    uploadStatus === 'error' || hasError ? "text-red-500/70" : "text-muted-foreground"
                )}>
                    {uploadStatus === 'uploading' ? (
                        <span className="truncate">Uploading...</span>
                    ) : uploadStatus === 'error' ? (
                        <span className="truncate">Upload failed</span>
                    ) : hasError ? (
                        <span className="truncate">Failed to load · Click to open</span>
                    ) : isLoading ? (
                        <span className="truncate">Loading...</span>
                    ) : (
                        <>
                            <span className="truncate">{typeLabel}</span>
                            <span className="flex-shrink-0">·</span>
                            <span className="flex-shrink-0">{fileSize}</span>
                        </>
                    )}
                </div>
            </div>
        </button>
    );

    // Wrap with alignment container if alignRight is true
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

