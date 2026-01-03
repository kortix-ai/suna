/**
 * AttachmentGroup - Compatibility wrapper for old AttachmentGroup interface
 * Maintains backward compatibility while using new components
 */

import React, { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { FileAttachment, FileAttachmentGrid } from './index';
import { Project } from '@/lib/api/threads';

type LayoutStyle = 'inline' | 'grid';

interface UploadedFile {
    name: string;
    path: string;
    size: number;
    type: string;
    localUrl?: string;
    fileId?: string;
    status?: 'pending' | 'uploading' | 'ready' | 'error';
}

interface AttachmentGroupProps {
    files: (string | UploadedFile)[];
    sandboxId?: string;
    onRemove?: (index: number) => void;
    layout?: LayoutStyle;
    className?: string;
    onFileClick?: (path: string, filePathList?: string[]) => void;
    showPreviews?: boolean;
    maxHeight?: string;
    gridImageHeight?: number;
    collapsed?: boolean;
    project?: Project;
    standalone?: boolean;
    alignRight?: boolean;
}

export function AttachmentGroup({
    files,
    sandboxId,
    onRemove,
    layout = 'inline',
    className,
    onFileClick,
    showPreviews = true,
    maxHeight = '216px',
    gridImageHeight = 180,
    collapsed = true,
    project,
    standalone = false,
    alignRight = false,
}: AttachmentGroupProps) {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 640);
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Deduplicate and extract file paths
    const uniqueFiles = (!files || files.length === 0)
        ? []
        : (typeof files[0] === 'string'
            ? [...new Set(files)] as string[]
            : files);

    const getFilePath = (file: string | UploadedFile): string => {
        return typeof file === 'string' ? file : file.path;
    };

    const getLocalPreviewUrl = (file: string | UploadedFile): string | undefined => {
        if (typeof file === 'string') return undefined;
        return file.localUrl;
    };

    const getUploadStatus = (file: string | UploadedFile): 'pending' | 'uploading' | 'ready' | 'error' | undefined => {
        if (typeof file === 'string') return undefined;
        return file.status;
    };

    const handleFileClick = (path: string) => {
        if (onFileClick) {
            const filePathList = uniqueFiles.map(file => getFilePath(file));
            onFileClick(path, filePathList);
        }
    };

    const maxVisibleFiles = isMobile ? 2 : 5;
    let visibleCount = Math.min(maxVisibleFiles, uniqueFiles.length);
    let moreCount = uniqueFiles.length - visibleCount;

    if (!isMobile && moreCount === 1) {
        visibleCount = uniqueFiles.length;
        moreCount = 0;
    }

    if (!files || files.length === 0) {
        return (
            <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className={layout === 'inline' ? "" : "mt-4"}
            />
        );
    }

    if (layout === 'grid') {
        // Use FileAttachmentGrid for grid layout
        const filePaths = uniqueFiles.map(getFilePath);
        return (
            <FileAttachmentGrid
                attachments={filePaths}
                sandboxId={sandboxId}
                showPreviews={showPreviews}
                collapsed={collapsed}
                project={project}
                standalone={standalone}
                alignRight={alignRight}
                className={className}
                onFileClick={onFileClick}
            />
        );
    }

    // Inline layout
    return (
        <>
            <AnimatePresence>
                <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className={cn("flex flex-wrap gap-3 isolate", className)}
                >
                    {uniqueFiles.slice(0, visibleCount).map((file, index) => {
                        const path = getFilePath(file);
                        return (
                            <div key={index} className="relative group overflow-visible">
                                <FileAttachment
                                    filepath={path}
                                    onClick={() => handleFileClick(path)}
                                    sandboxId={sandboxId}
                                    showPreview={showPreviews}
                                    localPreviewUrl={getLocalPreviewUrl(file)}
                                    collapsed={true}
                                    alignRight={alignRight}
                                    uploadStatus={getUploadStatus(file)}
                                />
                                {onRemove && (
                                    <div
                                        className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-black dark:bg-white border-3 border-sidebar text-white dark:text-black flex items-center justify-center z-10 cursor-pointer"
                                        onClick={() => onRemove(index)}
                                    >
                                        <TooltipProvider>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <div className="flex items-center justify-center w-full h-full">
                                                        <X size={10} strokeWidth={3} />
                                                    </div>
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    <p>Remove file</p>
                                                </TooltipContent>
                                            </Tooltip>
                                        </TooltipProvider>
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {moreCount > 0 && (
                        <button
                            onClick={() => setIsModalOpen(true)}
                            className={cn(
                                "h-[54px] rounded-xl cursor-pointer",
                                "border border-black/10 dark:border-white/10",
                                "bg-black/5 dark:bg-black/20",
                                "hover:bg-primary/10 dark:hover:bg-primary/20",
                                "flex items-center justify-center transition-colors",
                                isMobile ? "w-full" : "min-w-[120px] w-fit"
                            )}
                            title={`${moreCount} more ${moreCount === 1 ? 'file' : 'files'}`}
                        >
                            <div className="flex items-center gap-2">
                                <div className="flex items-center justify-center w-6 h-6 bg-primary/10 rounded-full">
                                    <Plus size={14} className="text-primary" />
                                </div>
                                <span className="text-sm font-medium">{moreCount} more</span>
                            </div>
                        </button>
                    )}
                </motion.div>
            </AnimatePresence>

            <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
                <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
                    <DialogHeader className="mb-1">
                        <DialogTitle>
                            <span>All Files ({uniqueFiles.length})</span>
                        </DialogTitle>
                    </DialogHeader>
                    <div className={cn(
                        "grid gap-4 auto-rows-auto items-stretch sm:justify-start justify-center sm:mx-0 isolate",
                        uniqueFiles.length === 1 ? "grid-cols-1" :
                            uniqueFiles.length > 4 ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-3" :
                                "grid-cols-1 sm:grid-cols-2",
                    )}>
                        {uniqueFiles.map((file, index) => {
                            const path = getFilePath(file);
                            return (
                                <div key={index} className="relative group overflow-visible">
                                    <FileAttachment
                                        filepath={path}
                                        onClick={(p) => {
                                            handleFileClick(p);
                                            setIsModalOpen(false);
                                        }}
                                        sandboxId={sandboxId}
                                        showPreview={showPreviews}
                                        localPreviewUrl={getLocalPreviewUrl(file)}
                                        collapsed={false}
                                        project={project}
                                        alignRight={false}
                                        uploadStatus={getUploadStatus(file)}
                                    />
                                    {onRemove && (
                                        <div
                                            className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-black dark:bg-white border-3 border-sidebar text-white dark:text-black flex items-center justify-center z-10 cursor-pointer"
                                            onClick={() => {
                                                onRemove(index);
                                                if (uniqueFiles.length <= 1) {
                                                    setIsModalOpen(false);
                                                }
                                            }}
                                        >
                                            <TooltipProvider>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <div className="flex items-center justify-center w-full h-full">
                                                            <X size={10} strokeWidth={3} />
                                                        </div>
                                                    </TooltipTrigger>
                                                    <TooltipContent side="top">
                                                        <p>Remove file</p>
                                                    </TooltipContent>
                                                </Tooltip>
                                            </TooltipProvider>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

