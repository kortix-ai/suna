'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Document, Page, pdfjs } from 'react-pdf';
import { Button } from '@/components/ui/button';
import {
  ChevronLeft,
  ChevronRight,
  Loader,
  AlertTriangle,
} from 'lucide-react';

// Import styles for annotations and text layer
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface PdfRendererProps {
  url: string;
  className?: string;
  /** Compact mode for inline previews - shows first page only, no controls */
  compact?: boolean;
}

export function PdfRenderer({ url, className, compact = false }: PdfRendererProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Track container width for responsive scaling - always fit to width
  useEffect(() => {
    if (!containerRef.current) return;
    
    const element = containerRef.current;
    const updateWidth = () => {
      // Use getBoundingClientRect for accurate width at any zoom level
      const rect = element.getBoundingClientRect();
      const width = Math.floor(rect.width);
      if (width > 0) {
        setContainerWidth(width);
      }
    };
    
    // Initial update
    updateWidth();
    
    // Use ResizeObserver for container size changes
    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(element);
    
    // Also listen to window resize for browser zoom changes
    window.addEventListener('resize', updateWidth);
    
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }): void {
    setNumPages(numPages);
    setIsLoading(false);
    setError(null);
  }

  function onDocumentLoadError(error: Error): void {
    console.error('PDF load error:', error);
    setError('Failed to load PDF');
    setIsLoading(false);
  }

  const goToPage = useCallback((page: number) => {
    if (page >= 1 && page <= (numPages || 1)) {
      setPageNumber(page);
      // Scroll to top when changing pages
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = 0;
      }
    }
  }, [numPages]);

  const previousPage = useCallback(() => {
    goToPage(pageNumber - 1);
  }, [pageNumber, goToPage]);

  const nextPage = useCallback(() => {
    goToPage(pageNumber + 1);
  }, [pageNumber, goToPage]);

  // Keyboard navigation
  useEffect(() => {
    if (compact) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          previousPage();
          break;
        case 'ArrowRight':
          e.preventDefault();
          nextPage();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [compact, previousPage, nextPage]);

  // Calculate page width - always fit to container with padding
  const pageWidth = containerWidth > 0 ? Math.max(containerWidth - 48, 100) : undefined;

  // Handle missing URL
  if (!url) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center bg-muted/20', className)}>
        <div className="text-sm text-muted-foreground">No PDF URL provided</div>
      </div>
    );
  }

  // Compact mode: first page only, no controls
  if (compact) {
    return (
      <div 
        ref={containerRef} 
        className={cn('w-full h-full overflow-hidden bg-muted/10', className)}
        style={{ contain: 'strict' }}
      >
        <div className="flex items-center justify-center p-2 overflow-auto h-full">
          <Document 
            file={url} 
            loading={
              <div className="flex items-center justify-center h-40">
                <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            }
            error={
              <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
                Failed to load PDF
              </div>
            }
          >
            <Page
              pageNumber={1}
              width={pageWidth}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              className="shadow-sm rounded-lg overflow-hidden"
            />
          </Document>
        </div>
      </div>
    );
  }

  // Full mode: PDF centered with pagination at bottom
  return (
    <div 
      ref={containerRef} 
      className={cn('flex flex-col w-full h-full bg-muted/20 overflow-hidden', className)}
      style={{ contain: 'strict' }}
    >
      {/* PDF content - centered */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-auto min-h-0"
      >
        {error ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Failed to load PDF</p>
              <p className="text-xs text-muted-foreground mt-1">The file may be corrupted or inaccessible</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center min-h-full p-4">
            <Document
              file={url}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={
                <div className="flex flex-col items-center justify-center h-64 gap-3">
                  <Loader className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Loading PDF...</p>
                </div>
              }
              className="flex flex-col items-center max-w-full"
            >
              <Page
                pageNumber={pageNumber}
                width={pageWidth}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                loading={
                  <div className="flex items-center justify-center h-64">
                    <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                }
                className="shadow-lg rounded-lg overflow-hidden bg-white max-w-full"
              />
            </Document>
          </div>
        )}
      </div>

      {/* Page navigation - bottom */}
      {numPages && numPages > 1 && (
        <div className="flex items-center justify-center px-3 py-2 bg-background border-t flex-shrink-0">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={previousPage}
              disabled={pageNumber <= 1}
              className="h-8 w-8 p-0"
              title="Previous page (←)"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            
            <div className="flex items-center gap-1.5 px-3">
              <span className="text-sm font-medium tabular-nums">
                {pageNumber}
              </span>
              <span className="text-sm text-muted-foreground">/</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {numPages}
              </span>
            </div>
            
            <Button
              variant="ghost"
              size="sm"
              onClick={nextPage}
              disabled={pageNumber >= numPages}
              className="h-8 w-8 p-0"
              title="Next page (→)"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
