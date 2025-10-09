import { AnimatePresence, motion } from 'framer-motion';
import { X, Plus } from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { FileAttachment } from './file-attachment';
import { cn } from '@/lib/utils';
import { Project } from '@/lib/api';
import { useState, useRef, useEffect } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';

type LayoutStyle = 'inline' | 'grid';

interface UploadedFile {
    name: string;
    path: string;
    size: number;
    type: string;
    localUrl?: string;
}

interface AttachmentGroupProps {
    // Support both path strings and full file objects
    files: (string | UploadedFile)[];
    sandboxId?: string;
    onRemove?: (index: number) => void;
    layout?: LayoutStyle;
    className?: string;
    onFileClick?: (path: string, filePathList?: string[]) => void;
    showPreviews?: boolean;
    maxHeight?: string;
    gridImageHeight?: number; // New prop for grid image height
    collapsed?: boolean; // Add new collapsed prop
    project?: Project; // Add project prop
    standalone?: boolean; // Add standalone prop for minimal styling
    alignRight?: boolean; // Add alignRight prop
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
    gridImageHeight = 180, // Increased from 120 for better visibility
    collapsed = true, // By default, HTML/MD files are collapsed
    project, // Add project prop
    standalone = false, // Add standalone prop
    alignRight = false // Add alignRight prop
}: AttachmentGroupProps) {
    // State for modal
    const [isModalOpen, setIsModalOpen] = useState(false);
    // Responsive state - ALWAYS initialize this hook first before any conditionals
    const [isMobile, setIsMobile] = useState(false);

    // Constants for height calculation - each row is about 66px (54px height + 12px gap)
    const ROW_HEIGHT = 54; // Height of a single file
    const GAP = 12; // Gap between rows (gap-3 = 0.75rem = 12px)
    const TWO_ROWS_HEIGHT = (ROW_HEIGHT * 2) + GAP; // Height of 2 rows plus gap

    // Check for mobile on mount and window resize
    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 640);
        };

        // Initial check
        checkMobile();

        // Add resize listener
        window.addEventListener('resize', checkMobile);

        // Clean up
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Return early with empty content if no files, but after hook initialization
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

    // Deduplicate attachments if they are strings - do this before any conditional rendering
    const uniqueFiles = typeof files[0] === 'string'
        ? [...new Set(files)] as string[]
        : files;

    // Get filepath from either string or UploadedFile
    const getFilePath = (file: string | UploadedFile): string => {
        return typeof file === 'string' ? file : file.path;
    };

    // Ensure path has proper format when clicking
    const handleFileClick = (path: string) => {
        if (onFileClick) {
            // Create the file path list from all files in the group
            const filePathList = uniqueFiles.map(file => getFilePath(file));
            // Pass both the clicked path and the complete list
            onFileClick(path, filePathList);
        }
    };

    // Get local preview URL if available (for UploadedFile)
    const getLocalPreviewUrl = (file: string | UploadedFile): string | undefined => {
        if (typeof file === 'string') return undefined;
        return !sandboxId ? file.localUrl : undefined;
    };

    // Check if a file is HTML, Markdown, CSV, XLSX, or PDF (previewable types in grid)
    const isPreviewableFile = (file: string | UploadedFile): boolean => {
        const path = getFilePath(file);
        const ext = path.split('.').pop()?.toLowerCase() || '';
        return (
            ext === 'html' ||
            ext === 'htm' ||
            ext === 'md' ||
            ext === 'markdown' ||
            ext === 'csv' ||
            ext === 'tsv' ||
            ext === 'xlsx' ||
            ext === 'xls' ||
            ext === 'pdf'
        );
    };

    // Pre-compute any conditional values used in rendering
    // This ensures hooks aren't conditionally called
    const maxVisibleFiles = isMobile ? 2 : 5;
    let visibleCount = Math.min(maxVisibleFiles, uniqueFiles.length);
    
    // Use standalone mode to optimize grid layout for all file types
    let moreCount = uniqueFiles.length - visibleCount;

    // If there's just a single file more on desktop, show it
    if (!isMobile && moreCount === 1) {
        visibleCount = uniqueFiles.length;
        moreCount = 0;
    }

    // Pre-process files for rendering to avoid conditional logic in JSX
    const visibleFilesWithMeta = uniqueFiles.slice(0, visibleCount).map((file, index) => {
        const path = getFilePath(file);
        const filename = path.split('/').pop() || '';
        const isImage = filename.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) !== null;
        return {
            file,
            path,
            isImage,
            wrapperClassName: isMobile && !isImage ? "w-full" : ""
        };
    });

    // For grid layout, prepare sorted files
    const sortedFiles = [...uniqueFiles].sort((a, b) => {
        // Helper function to check if a file is an image
        const isImage = (file: string | UploadedFile) => {
            const path = getFilePath(file);
            const filename = path.split('/').pop() || '';
            return filename.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) !== null;
        };

        // Helper to check for previewable files
        const isPreviewFile = (file: string | UploadedFile) => isPreviewableFile(file);

        // First sort criteria: images come first
        const aIsImage = isImage(a);
        const bIsImage = isImage(b);

        if (aIsImage && !bIsImage) return -1;
        if (!aIsImage && bIsImage) return 1;

        // Second sort criteria: uncollapsed previewable files at the end
        const aIsUncollapsedPreview = !collapsed && isPreviewFile(a);
        const bIsUncollapsedPreview = !collapsed && isPreviewFile(b);

        return aIsUncollapsedPreview === bIsUncollapsedPreview ? 0 : aIsUncollapsedPreview ? 1 : -1;
    });

    // Process files for grid layout with all metadata needed for rendering
    const sortedFilesWithMeta = sortedFiles.map((file, index) => {
        const path = getFilePath(file);
        const filename = path.split('/').pop() || '';
        const isImage = filename.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) !== null;
        const isPreviewFile = isPreviewableFile(file);

        return {
            file,
            path,
            isImage,
            isPreviewFile,
            wrapperClassName: cn(
                "relative group",
                isImage ? "flex items-start justify-center" : "",
                isPreviewFile ? "w-full" : "" // Previewable files span full width
            ),
            wrapperStyle: isPreviewFile ? { gridColumn: '1 / -1' } : undefined // Make previewable files span full width like in CompleteToolView
        };
    });

    // Now continue with the fully conditional rendering but with pre-computed values
    const renderContent = () => {
        if (layout === 'grid') {
            return (
                <div className={cn(
                    "grid gap-3 auto-rows-max items-start",
                    // Responsive grid columns based on file count
                    uniqueFiles.length === 1 ? "grid-cols-1" :
                        uniqueFiles.length === 2 ? "grid-cols-1 sm:grid-cols-2" :
                            uniqueFiles.length === 3 ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-3" :
                                uniqueFiles.length >= 4 ? "grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4" :
                                    "grid-cols-1 sm:grid-cols-2",
                    className
                )}>
                    {sortedFilesWithMeta.map((item, index) => (
                        <div
                            key={index}
                            className={cn(
                                item.wrapperClassName,
                                // Images and previewable files span naturally, regular files are compact
                                item.isImage || item.isPreviewFile ? "w-full" : ""
                            )}
                            style={item.wrapperStyle}
                        >
                            <FileAttachment
                                filepath={item.path}
                                onClick={handleFileClick}
                                sandboxId={sandboxId}
                                showPreview={showPreviews}
                                localPreviewUrl={getLocalPreviewUrl(item.file)}
                                className={cn(
                                    "w-full",
                                    item.isImage ? "h-auto min-h-[54px]" :
                                        item.isPreviewFile ? "min-h-[240px] max-h-[400px]" : "h-[54px]" // Regular files are compact 54px
                                )}
                                // Pass customStyle for sizing - MUST include gridColumn for previewable files to trigger preview
                                customStyle={
                                    item.isImage ? {
                                        width: '100%',
                                        height: 'auto',
                                        maxHeight: `${gridImageHeight}px`,
                                        '--attachment-height': `${gridImageHeight}px`
                                    } as React.CSSProperties :
                                        item.isPreviewFile ? {
                                            gridColumn: '1 / -1', // This triggers isGridLayout and preview rendering!
                                            width: '100%'
                                        } : undefined // Regular files get no custom style
                                }
                                collapsed={false} // Always show previews in grid like in CompleteToolView
                                project={project} // Pass project to FileAttachment
                                isSingleItemGrid={uniqueFiles.length === 1} // Pass single item detection
                                standalone={standalone} // Pass standalone prop
                                alignRight={alignRight} // Pass alignRight prop
                            />
                            {onRemove && (
                                <div
                                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full
                                    bg-black dark:bg-white
                                    border-3 border-sidebar
                                    text-white dark:text-black flex items-center justify-center
                                    z-30 cursor-pointer"
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
                    ))}
                </div>
            );
        } else {
            // For inline layout with pre-computed data
            return (
                <div className={cn("flex flex-wrap gap-3", className)}>
                    {visibleFilesWithMeta.map((item, index) => {
                        const isHtml = item.path.match(/\.(html|htm)$/i) !== null;
                        const isPreviewable = item.path.match(/\.(html|htm|md|markdown|csv|tsv)$/i) !== null;
                        
                        return (
                            <div 
                                key={index} 
                                className={cn(
                                    "relative group",
                                    isPreviewable ? "w-full" : "h-[54px]",
                                    item.wrapperClassName
                                )}
                                style={isPreviewable ? { gridColumn: '1 / -1' } : undefined}
                            >
                                <FileAttachment
                                    filepath={item.path}
                                    onClick={handleFileClick}
                                    sandboxId={sandboxId}
                                    showPreview={showPreviews}
                                    localPreviewUrl={getLocalPreviewUrl(item.file)}
                                    collapsed={false} // Show previews like in CompleteToolView
                                    alignRight={alignRight} // Pass alignRight prop
                                    className={cn(
                                        isPreviewable ? "min-h-[240px] max-h-[400px] overflow-auto" : ""
                                    )}
                                    customStyle={
                                        isPreviewable ? {
                                            gridColumn: '1 / -1',
                                            width: '100%'
                                        } : undefined
                                    }
                                />
                                {onRemove && (
                                <div
                                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full
                                        bg-black dark:bg-white
                                        border-3 border-sidebar
                                        text-white dark:text-black flex items-center justify-center
                                        z-30 cursor-pointer"
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

                    {/* "More" button */}
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
                </div>
            );
        }
    };

    return (
        <>
            <AnimatePresence>
                <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{
                        opacity: 1, height: 'auto'
                    }}
                    exit={{ opacity: 0, height: 0 }}
                    className={layout === 'inline' ? "pt-1.5 px-1.5 pb-0" : "mt-4"}
                >
                    {renderContent()}
                </motion.div>
            </AnimatePresence >

            {/* Modal dialog to show all files - conditionally rendered based on isModalOpen state */}
            < Dialog open={isModalOpen} onOpenChange={setIsModalOpen} >
                <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
                    <DialogHeader className="mb-1">
                        <DialogTitle>
                            <span>All Files ({uniqueFiles.length})</span>
                        </DialogTitle>
                    </DialogHeader>

                    <div className={cn(
                        "grid gap-3 auto-rows-max items-start sm:justify-start justify-center sm:mx-0",
                        // Force single column for standalone files in modal too with better width constraints
                        standalone && !collapsed ? "grid-cols-1 w-full min-w-[300px] sm:min-w-[600px] max-w-[1200px] mx-auto" :
                            "sm:max-w-full max-w-[300px] mx-auto",
                        uniqueFiles.length === 1 ? "grid-cols-1" :
                            uniqueFiles.length > 4 ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-3" :
                                "grid-cols-1 sm:grid-cols-2",
                    )}>
                        {(() => {
                            // Pre-compute all values needed for rendering to avoid hook conditionals
                            const modalFilesWithMeta = (() => {
                                // Create sorted files array (same logic as above)
                                const sortedModalFiles = [...uniqueFiles].sort((a, b) => {
                                    // Helper function to check if a file is an image
                                    const isImage = (file: string | UploadedFile) => {
                                        const path = getFilePath(file);
                                        const filename = path.split('/').pop() || '';
                                        return filename.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) !== null;
                                    };

                                    // Sort images first
                                    const aIsImage = isImage(a);
                                    const bIsImage = isImage(b);

                                    if (aIsImage && !bIsImage) return -1;
                                    if (!aIsImage && bIsImage) return 1;
                                    return 0;
                                });

                                // Create map of sorted indices to original indices
                                const indexMap = sortedModalFiles.map(file =>
                                    uniqueFiles.findIndex(f =>
                                        getFilePath(f) === getFilePath(file)
                                    )
                                );

                                return sortedModalFiles.map((file, displayIndex) => {
                                    // Get the original index for removal
                                    const originalIndex = indexMap[displayIndex];
                                    // File properties
                                    const path = getFilePath(file);
                                    const filename = path.split('/').pop() || '';
                                    const isImage = filename.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i) !== null;
                                    const isPreviewFile = isPreviewableFile(file);

                                    return {
                                        file,
                                        path,
                                        isImage,
                                        isPreviewFile,
                                        originalIndex,
                                        wrapperClassName: cn(
                                            "relative group",
                                            isImage ? "flex items-start justify-center" : "",
                                            isPreviewFile ? "w-full" : ""
                                        ),
                                        fileClassName: cn(
                                            "w-full",
                                            isImage ? "h-auto min-h-[54px]" :
                                                isPreviewFile ? "min-h-[240px] max-h-[400px]" : "h-[54px]"
                                        ),
                                        customStyle: isImage ? {
                                            width: '100%',
                                            height: 'auto',
                                            maxHeight: `${gridImageHeight}px`,
                                            '--attachment-height': `${gridImageHeight}px`
                                        } as React.CSSProperties :
                                            isPreviewFile ? {
                                                gridColumn: '1 / -1', // This triggers isGridLayout and preview rendering!
                                                width: '100%'
                                            } : undefined // Regular files get no custom style
                                    };
                                });
                            })();

                            return modalFilesWithMeta.map((item) => (
                                <div
                                    key={item.originalIndex}
                                    className={item.wrapperClassName}
                                    style={item.isPreviewFile ? { gridColumn: '1 / -1' } : undefined}
                                >
                                    <FileAttachment
                                        filepath={item.path}
                                        onClick={(path) => {
                                            handleFileClick(path);
                                            setIsModalOpen(false);
                                        }}
                                        sandboxId={sandboxId}
                                        showPreview={showPreviews}
                                        localPreviewUrl={getLocalPreviewUrl(item.file)}
                                        className={item.fileClassName}
                                        customStyle={item.customStyle}
                                        collapsed={false} // Show previews like in CompleteToolView
                                        project={project}
                                        isSingleItemGrid={uniqueFiles.length === 1} // Pass single item detection to modal too
                                        standalone={false} // Never standalone in modal
                                        alignRight={false} // Never align right in modal
                                    />
                                    {onRemove && (
                                        <div
                                            className="absolute -top-1 -right-1 h-5 w-5 rounded-full
                                                bg-black dark:bg-white
                                                border-3 border-sidebar
                                                text-white dark:text-black flex items-center justify-center
                                                z-30 cursor-pointer"
                                            onClick={() => {
                                                onRemove(item.originalIndex);
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
                            ));
                        })()}
                    </div>
                </DialogContent>
            </Dialog >
        </>
    );
} 