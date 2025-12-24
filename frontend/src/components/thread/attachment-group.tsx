import { AnimatePresence, motion } from 'framer-motion';
import { X, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { FileAttachment } from './file-attachment';
import { cn } from '@/lib/utils';
import { isPreviewableFile as isPreviewableFilePath, isImageFile as isImageFilePath } from '@/lib/utils/file-types';
import { Project } from '@/lib/api/threads';
import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
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
    fileId?: string;
    status?: 'pending' | 'uploading' | 'ready' | 'error';
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
    // Simple carousel state - show one item at a time - MUST be before any early returns
    const [currentIndex, setCurrentIndex] = useState(0);

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

    // Deduplicate attachments if they are strings - do this before any conditional rendering
    // Compute this before early return so hooks can use it
    const uniqueFiles = (!files || files.length === 0)
        ? []
        : (typeof files[0] === 'string'
            ? [...new Set(files)] as string[]
            : files);

    // Compute carousel navigation values before early return (safe even with no files)
    const canGoPrev = currentIndex > 0;
    const canGoNext = currentIndex < uniqueFiles.length - 1;
    
    const handlePrev = useCallback(() => {
        setCurrentIndex(prev => {
            if (prev > 0) {
                return prev - 1;
            }
            return prev;
        });
    }, []);
    
    const handleNext = useCallback(() => {
        setCurrentIndex(prev => {
            if (prev < uniqueFiles.length - 1) {
                return prev + 1;
            }
            return prev;
        });
    }, [uniqueFiles.length]);

    // Keyboard navigation for carousel - MUST be before early return
    useEffect(() => {
        if (layout !== 'grid' || uniqueFiles.length < 2) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Only handle if not typing in an input/textarea
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                (e.target instanceof HTMLElement && e.target.isContentEditable)
            ) {
                return;
            }

            if (e.key === 'ArrowLeft' && canGoPrev) {
                e.preventDefault();
                handlePrev();
            } else if (e.key === 'ArrowRight' && canGoNext) {
                e.preventDefault();
                handleNext();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [layout, uniqueFiles.length, currentIndex, canGoPrev, canGoNext, handlePrev, handleNext]);

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
    // Always use local preview (blob URL) when available - it's instant and independent of upload
    const getLocalPreviewUrl = (file: string | UploadedFile): string | undefined => {
        if (typeof file === 'string') return undefined;
        return file.localUrl;
    };

    const getUploadStatus = (file: string | UploadedFile): 'pending' | 'uploading' | 'ready' | 'error' | undefined => {
        if (typeof file === 'string') return undefined;
        return file.status;
    };

    // Check if a file is previewable (HTML, Markdown, JSON, CSV, XLSX, PDF)
    const isPreviewableFile = (file: string | UploadedFile): boolean => {
        return isPreviewableFilePath(getFilePath(file));
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
    
    // Determine if we should use carousel (3+ attachments for better UX)
    const shouldUseCarousel = layout === 'grid' && uniqueFiles.length >= 2;

    // Now continue with the fully conditional rendering but with pre-computed values
    const renderContent = () => {
        if (layout === 'grid') {
            // Use carousel for many attachments - show one item at a time
            if (shouldUseCarousel) {
                const currentItem = sortedFilesWithMeta[currentIndex];
                const currentFilePath = getFilePath(currentItem.file);
                
                return (
                    <div className={cn("relative isolate", className)}>
                        {/* Carousel Navigation - Enhanced for visibility */}
                        <div className="flex items-center justify-between mb-3 px-1">
                            <div className="flex items-center gap-2">
                                <div className="text-xs font-medium text-foreground">
                                    {uniqueFiles.length} {uniqueFiles.length === 1 ? 'file' : 'files'}
                                </div>
                                <div className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                                <div className="text-xs text-muted-foreground">
                                    Use arrows to navigate
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={handlePrev}
                                                disabled={!canGoPrev}
                                                className="h-8 w-8 p-0 border-2 hover:bg-accent hover:border-accent-foreground/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            <p>Previous file</p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                                
                                {/* Progress dots indicator */}
                                <div className="flex items-center gap-1.5">
                                    {uniqueFiles.map((_, idx) => (
                                        <button
                                            key={idx}
                                            onClick={() => setCurrentIndex(idx)}
                                            className={cn(
                                                "h-2 rounded-full transition-all duration-200",
                                                idx === currentIndex
                                                    ? "w-6 bg-primary"
                                                    : "w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50"
                                            )}
                                            aria-label={`Go to file ${idx + 1}`}
                                        />
                                    ))}
                                </div>
                                
                                <div className="text-sm font-medium text-foreground min-w-[50px] text-center">
                                    {currentIndex + 1} / {uniqueFiles.length}
                                </div>
                                
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={handleNext}
                                                disabled={!canGoNext}
                                                className="h-8 w-8 p-0 border-2 hover:bg-accent hover:border-accent-foreground/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                            >
                                                <ChevronRight className="h-4 w-4" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            <p>Next file</p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            </div>
                        </div>
                        
                        {/* Single Item Display with smooth transition */}
                        <div className="relative isolate">
                            <AnimatePresence mode="wait">
                                <motion.div
                                    key={currentIndex}
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    transition={{ duration: 0.2 }}
                                >
                                    <div className={cn(
                                        "relative overflow-visible",
                                        currentItem.isImage ? "flex items-start justify-center" : "",
                                        currentItem.isPreviewFile ? "w-full" : ""
                                    )} style={currentItem.wrapperStyle}>
                                        <FileAttachment
                                            filepath={currentFilePath}
                                            onClick={handleFileClick}
                                            sandboxId={sandboxId}
                                            showPreview={showPreviews}
                                            localPreviewUrl={getLocalPreviewUrl(currentItem.file)}
                                            className={cn(
                                                "w-full",
                                                currentItem.isImage ? "h-auto min-h-[54px]" :
                                                    currentItem.isPreviewFile ? "min-h-[240px] max-h-[400px]" : "h-[54px]"
                                            )}
                                            customStyle={
                                                currentItem.isImage ? {
                                                    width: '100%',
                                                    height: 'auto',
                                                    maxHeight: `${gridImageHeight}px`,
                                                    '--attachment-height': `${gridImageHeight}px`
                                                } as React.CSSProperties :
                                                    currentItem.isPreviewFile ? {
                                                        gridColumn: '1 / -1',
                                                        width: '100%'
                                                    } : undefined
                                            }
                                            collapsed={false}
                                            project={project}
                                            isSingleItemGrid={true}
                                            standalone={standalone}
                                            alignRight={alignRight}
                                        />
                                        {onRemove && (
                                            <div
                                                className="absolute -top-1 -right-1 h-5 w-5 rounded-full
                                                bg-black dark:bg-white
                                                border-3 border-sidebar
                                                text-white dark:text-black flex items-center justify-center
                                                z-10 cursor-pointer"
                                                onClick={() => {
                                                    const originalIndex = uniqueFiles.findIndex(f => 
                                                        getFilePath(f) === currentFilePath
                                                    );
                                                    if (originalIndex !== -1) {
                                                        onRemove(originalIndex);
                                                        // Adjust current index if needed
                                                        if (currentIndex >= uniqueFiles.length - 1 && currentIndex > 0) {
                                                            setCurrentIndex(prev => prev - 1);
                                                        }
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
                                </motion.div>
                            </AnimatePresence>
                        </div>
                    </div>
                );
            }
            
            // Regular layout for fewer attachments
            // Separate previewable files from compact files for proper layout
            const compactFiles = sortedFilesWithMeta.filter(item => !item.isPreviewFile);
            const previewableFiles = sortedFilesWithMeta.filter(item => item.isPreviewFile);
            
            return (
                <div className={cn("flex flex-col gap-3 isolate", className)}>
                    {/* Compact files - flex wrap so they go side-by-side when space allows */}
                    {compactFiles.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {compactFiles.map((item, index) => (
                                <div
                                    key={`compact-${index}`}
                                    className={cn(
                                        "relative group overflow-visible",
                                        item.isImage 
                                            ? "flex items-start justify-center w-full" 
                                            : "flex-1 min-w-[180px] max-w-full"
                                    )}
                                >
                                    <FileAttachment
                                        filepath={item.path}
                                        onClick={handleFileClick}
                                        sandboxId={sandboxId}
                                        showPreview={showPreviews}
                                        localPreviewUrl={getLocalPreviewUrl(item.file)}
                                        className={cn(
                                            "w-full",
                                            item.isImage ? "h-auto min-h-[54px]" : "h-[54px]"
                                        )}
                                        customStyle={
                                            item.isImage ? {
                                                width: '100%',
                                                height: 'auto',
                                                maxHeight: `${gridImageHeight}px`,
                                                '--attachment-height': `${gridImageHeight}px`
                                            } as React.CSSProperties : undefined
                                        }
                                        collapsed={false}
                                        project={project}
                                        isSingleItemGrid={uniqueFiles.length === 1}
                                        standalone={standalone}
                                        alignRight={alignRight}
                                    />
                                    {onRemove && (
                                        <div
                                            className="absolute -top-1 -right-1 h-5 w-5 rounded-full
                                            bg-black dark:bg-white
                                            border-3 border-sidebar
                                            text-white dark:text-black flex items-center justify-center
                                            z-10 cursor-pointer"
                                            onClick={() => {
                                                const originalIndex = sortedFilesWithMeta.findIndex(f => f.path === item.path);
                                                if (originalIndex !== -1) onRemove(originalIndex);
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
                            ))}
                        </div>
                    )}
                    
                    {/* Previewable files each on their own row */}
                    {previewableFiles.map((item, index) => (
                        <div
                            key={`preview-${index}`}
                            className="relative group overflow-visible w-full"
                        >
                            <FileAttachment
                                filepath={item.path}
                                onClick={handleFileClick}
                                sandboxId={sandboxId}
                                showPreview={showPreviews}
                                localPreviewUrl={getLocalPreviewUrl(item.file)}
                                className="w-full min-h-[240px] max-h-[400px]"
                                customStyle={{
                                    gridColumn: '1 / -1', // This triggers isGridLayout and preview rendering!
                                    width: '100%'
                                }}
                                collapsed={false}
                                project={project}
                                isSingleItemGrid={uniqueFiles.length === 1}
                                standalone={standalone}
                                alignRight={alignRight}
                            />
                            {onRemove && (
                                <div
                                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full
                                    bg-black dark:bg-white
                                    border-3 border-sidebar
                                    text-white dark:text-black flex items-center justify-center
                                    z-10 cursor-pointer"
                                    onClick={() => {
                                        const originalIndex = sortedFilesWithMeta.findIndex(f => f.path === item.path);
                                        if (originalIndex !== -1) onRemove(originalIndex);
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
                    ))}
                </div>
            );
        } else {
            // For inline layout with pre-computed data
            return (
                <div className={cn("flex flex-wrap gap-3 isolate", className)}>
                    {visibleFilesWithMeta.map((item, index) => {
                        // In inline mode (chat input), ALL files should show as compact attachments
                        // No preview expansion - keep it simple and consistent
                        const isPreviewable = false;

                            return (
                            <div
                                key={index}
                                className="relative group overflow-visible"
                            >
                                <FileAttachment
                                    filepath={item.path}
                                    onClick={handleFileClick}
                                    sandboxId={sandboxId}
                                    showPreview={showPreviews}
                                    localPreviewUrl={getLocalPreviewUrl(item.file)}
                                    collapsed={true}
                                    alignRight={alignRight}
                                    uploadStatus={getUploadStatus(item.file)}
                                />
                                {onRemove && (
                                    <div
                                        className="absolute -top-1 -right-1 h-5 w-5 rounded-full
                                        bg-black dark:bg-white
                                        border-3 border-sidebar
                                        text-white dark:text-black flex items-center justify-center
                                        z-10 cursor-pointer"
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
                    className={cn(
                        layout === 'inline' ? "pt-1.5 px-1.5 pb-0" : "mt-4 mb-2",
                        "isolate relative"
                    )}
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
                        "grid gap-4 auto-rows-auto items-stretch sm:justify-start justify-center sm:mx-0 isolate",
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
                                            "relative group overflow-visible",
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
                                                z-10 cursor-pointer"
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