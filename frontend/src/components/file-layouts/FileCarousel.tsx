/**
 * FileCarousel - Carousel navigation for multiple files
 */

import React, { useState, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileCard } from '../file-previews/FileCard';
import { isPreviewableFile } from '@/lib/utils/file-types';

export interface FileCarouselProps {
    files: string[];
    currentIndex: number;
    onIndexChange: (index: number) => void;
    children: (filepath: string, index: number) => React.ReactNode;
    className?: string;
}

export function FileCarousel({
    files,
    currentIndex,
    onIndexChange,
    children,
    className,
}: FileCarouselProps) {
    const canGoPrev = currentIndex > 0;
    const canGoNext = currentIndex < files.length - 1;
    
    const handlePrev = useCallback(() => {
        if (canGoPrev) {
            onIndexChange(currentIndex - 1);
        }
    }, [canGoPrev, currentIndex, onIndexChange]);
    
    const handleNext = useCallback(() => {
        if (canGoNext) {
            onIndexChange(currentIndex + 1);
        }
    }, [canGoNext, currentIndex, onIndexChange]);
    
    // Keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
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
    }, [canGoPrev, canGoNext, handlePrev, handleNext]);
    
    const currentFile = files[currentIndex];
    
    return (
        <div className={cn("relative isolate", className)}>
            {/* Navigation Header */}
            <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-foreground">
                        {files.length} {files.length === 1 ? 'file' : 'files'}
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
                    
                    {/* Progress dots */}
                    <div className="flex items-center gap-1.5">
                        {files.map((_, idx) => (
                            <button
                                key={idx}
                                onClick={() => onIndexChange(idx)}
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
                        {currentIndex + 1} / {files.length}
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
            
            {/* File Display with Animation */}
            <div className="relative isolate">
                <AnimatePresence mode="wait">
                    <motion.div
                        key={currentIndex}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={{ duration: 0.2 }}
                    >
                        {currentFile && (
                            <div className="relative overflow-visible">
                                {children(currentFile, currentIndex)}
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
            </div>
        </div>
    );
}

