'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Document, Page, pdfjs } from 'react-pdf';
import { Button } from '@/components/ui/button';
import {
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';

// Import styles for annotations and text layer
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker
// Use the worker from /public for reliable loading across Next.js dev (Turbopack) and production builds.
// The file is copied from node_modules/pdfjs-dist/build/pdf.worker.min.mjs during setup.
// Falls back to unpkg CDN if the local file is unavailable.
pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;

// ── Zoom presets ──────────────────────────────────────────────────────────

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;
const DEFAULT_ZOOM_INDEX = 2; // 1x = fit-to-width

interface PdfRendererProps {
  /** URL to load the PDF from (can be a blob URL or http URL) */
  url?: string;
  /** Raw PDF blob — preferred over url to avoid pdfjs header issues with blob URLs */
  blob?: Blob | null;
  className?: string;
  /** Compact mode for inline previews - shows first page only, no controls */
  compact?: boolean;
}

export function PdfRenderer({ url, blob, className, compact = false }: PdfRendererProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Create a blob URL from the raw blob.
  // We pass this URL to pdfjs with disableRange + disableStream so it does
  // a simple GET fetch — no range-request headers (which fail on blob URLs)
  // and no ArrayBuffer transfer (which causes "detached ArrayBuffer" on re-render).
  // NOTE: We do NOT revoke on unmount — pdfjs loads asynchronously and crashes
  // with "Unexpected response (0)" if the URL is revoked while it's still
  // fetching. The URL is only revoked when the blob itself changes.
  const prevBlobRef = useRef<Blob | null>(null);
  useEffect(() => {
    if (!blob) {
      setBlobUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
      prevBlobRef.current = null;
      return;
    }
    if (blob === prevBlobRef.current) return;
    prevBlobRef.current = blob;
    setBlobUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
  }, [blob]);

  const zoomLevel = ZOOM_LEVELS[zoomIndex];

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

  function onDocumentLoadError(err: Error): void {
    setError(err.message || 'Failed to load PDF');
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

  // ── Zoom controls ────────────────────────────────────────────────────────

  const canZoomIn = zoomIndex < ZOOM_LEVELS.length - 1;
  const canZoomOut = zoomIndex > 0;
  const isDefaultZoom = zoomIndex === DEFAULT_ZOOM_INDEX;

  const zoomIn = useCallback(() => {
    setZoomIndex((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1));
  }, []);

  const zoomOut = useCallback(() => {
    setZoomIndex((i) => Math.max(i - 1, 0));
  }, []);

  const resetZoom = useCallback(() => {
    setZoomIndex(DEFAULT_ZOOM_INDEX);
  }, []);

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
        case '=':
        case '+':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            zoomIn();
          }
          break;
        case '-':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            zoomOut();
          }
          break;
        case '0':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            resetZoom();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [compact, previousPage, nextPage, zoomIn, zoomOut, resetZoom]);

  // Calculate page width — base width fit to container, then scaled by zoom
  const baseWidth = containerWidth > 0 ? Math.max(containerWidth - 48, 100) : undefined;
  const pageWidth = baseWidth ? Math.round(baseWidth * zoomLevel) : undefined;

  // Determine the file source for <Document>.
  // Use blob URL (from blob prop) with range/stream disabled — pdfjs does a
  // simple GET fetch. This avoids:
  //  1. "Failed to construct Headers" (range request headers on blob URLs)
  //  2. "Cannot perform Construct on detached ArrayBuffer" (ArrayBuffer transfer)
  // Memoized to prevent react-pdf "file prop changed but is equal" warnings.
  const resolvedUrl = blobUrl || url || null;
  const pdfFile = useMemo(
    () => resolvedUrl ? { url: resolvedUrl, disableRange: true, disableStream: true } : null,
    [resolvedUrl],
  );

  // Handle missing source
  if (!pdfFile) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center bg-muted/20', className)}>
        <div className="text-sm text-muted-foreground">No PDF source provided</div>
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
            file={pdfFile} 
            loading={
              <div className="flex items-center justify-center h-40">
                <KortixLoader size="medium" />
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
              width={baseWidth}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              className="shadow-sm rounded-lg overflow-hidden"
            />
          </Document>
        </div>
      </div>
    );
  }

  // Full mode: PDF centered with zoom + pagination at bottom
  return (
    <div 
      ref={containerRef} 
      className={cn('flex flex-col w-full h-full bg-muted/20 overflow-hidden', className)}
      style={{ contain: 'strict' }}
    >
      {/* PDF content - centered, scrollable when zoomed */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-auto min-h-0"
      >
        {error ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Failed to load PDF</p>
              <p className="text-xs text-muted-foreground mt-1">The file may be corrupted or inaccessible</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-center min-h-full p-4">
            <Document
              file={pdfFile}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={
                <div className="flex flex-col items-center justify-center h-64 gap-3">
                  <KortixLoader size="medium" />
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
                    <KortixLoader size="medium" />
                  </div>
                }
                className="shadow-lg rounded-lg overflow-hidden bg-white"
              />
            </Document>
          </div>
        )}
      </div>

      {/* Bottom toolbar: zoom + page navigation */}
      {!isLoading && !error && numPages && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-background border-t flex-shrink-0">
          {/* Zoom controls — left */}
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={zoomOut}
              disabled={!canZoomOut}
              className="h-7 w-7 p-0"
              title="Zoom out (Cmd+-)"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>

            <button
              type="button"
              onClick={resetZoom}
              disabled={isDefaultZoom}
              className={cn(
                'h-7 px-1.5 rounded text-xs tabular-nums font-medium transition-colors',
                isDefaultZoom
                  ? 'text-muted-foreground/50 cursor-default'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer',
              )}
              title="Reset zoom (Cmd+0)"
            >
              {Math.round(zoomLevel * 100)}%
            </button>

            <Button
              variant="ghost"
              size="sm"
              onClick={zoomIn}
              disabled={!canZoomIn}
              className="h-7 w-7 p-0"
              title="Zoom in (Cmd++)"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Page navigation — center/right */}
          {numPages > 1 ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={previousPage}
                disabled={pageNumber <= 1}
                className="h-7 w-7 p-0"
                title="Previous page (←)"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              
              <div className="flex items-center gap-1 px-2">
                <span className="text-xs font-medium tabular-nums">
                  {pageNumber}
                </span>
                <span className="text-xs text-muted-foreground">/</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {numPages}
                </span>
              </div>
              
              <Button
                variant="ghost"
                size="sm"
                onClick={nextPage}
                disabled={pageNumber >= numPages}
                className="h-7 w-7 p-0"
                title="Next page (→)"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div /> /* spacer for single-page PDFs */
          )}
        </div>
      )}
    </div>
  );
}
