/**
 * PdfThumbnail - Lightweight PDF first-page thumbnail preview
 * Renders a small thumbnail of page 1 using react-pdf, with lazy loading via IntersectionObserver.
 */

'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { cn } from '@/lib/utils';
import { getFilename, getFileIcon } from '@/lib/utils/file-utils';
import { useFileContentQuery } from '@/hooks/files/use-file-queries';
import { KortixLoader } from '@/components/ui/kortix-loader';

// Configure PDF.js worker (idempotent — same as pdf-renderer.tsx)
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
).toString();

export interface PdfThumbnailProps {
    filepath: string;
    sandboxId?: string;
    localPreviewUrl?: string;
    onClick?: () => void;
    className?: string;
    uploadStatus?: 'pending' | 'uploading' | 'ready' | 'error';
    isGridLayout?: boolean;
}

export function PdfThumbnail({
    filepath,
    sandboxId,
    localPreviewUrl,
    onClick,
    className,
    uploadStatus,
    isGridLayout = false,
}: PdfThumbnailProps) {
    const filename = getFilename(filepath);
    const IconComponent = getFileIcon('pdf');

    // Lazy loading: only mount <Document> when the element is visible
    const containerRef = useRef<HTMLButtonElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setIsVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: '200px' },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Fetch blob from sandbox when no local preview
    const needsSandboxFetch = !localPreviewUrl && !!sandboxId && !!filepath;
    const { data: blobData, isLoading, error, failureCount } = useFileContentQuery(
        needsSandboxFetch ? sandboxId : undefined,
        needsSandboxFetch ? filepath : undefined,
        {
            contentType: 'blob',
            enabled: needsSandboxFetch && isVisible,
        },
    );

    // Create blob URL from fetched data
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    useEffect(() => {
        if (blobData instanceof Blob) {
            const pdfBlob = new Blob([blobData], { type: 'application/pdf' });
            const url = URL.createObjectURL(pdfBlob);
            setBlobUrl(url);
            return () => {
                URL.revokeObjectURL(url);
                setBlobUrl(null);
            };
        } else {
            setBlobUrl(null);
        }
    }, [blobData]);

    const pdfUrl = localPreviewUrl || blobUrl;
    const hasError = error && (failureCount || 0) >= 15;
    const isStillLoading = (isLoading || (!pdfUrl && !hasError)) && !localPreviewUrl && needsSandboxFetch;

    // Page loaded state for smooth reveal
    const [pageLoaded, setPageLoaded] = useState(false);

    // Sizing
    const thumbnailWidth = isGridLayout ? 300 : 60;

    // Loading state
    if (!localPreviewUrl && isStillLoading && isVisible) {
        return (
            <button
                ref={containerRef}
                className={cn(
                    "relative rounded-2xl",
                    "border border-border/50",
                    "bg-muted/20",
                    "flex flex-col items-center justify-center gap-2",
                    isGridLayout ? "w-full aspect-[4/3] min-h-[200px]" : "h-[72px] w-[72px] rounded-xl",
                    className,
                )}
                title="Loading PDF..."
            >
                <KortixLoader size="medium" />
            </button>
        );
    }

    // Error state
    if (hasError) {
        return (
            <button
                ref={containerRef}
                onClick={onClick}
                className={cn(
                    "group relative rounded-xl cursor-pointer",
                    "border border-red-500/20 dark:border-red-500/30",
                    "bg-red-500/5 dark:bg-red-500/10",
                    "p-0 overflow-hidden",
                    "flex flex-col items-center justify-center gap-2",
                    isGridLayout ? "w-full aspect-[4/3]" : "h-[72px] w-[72px] rounded-xl",
                    className,
                )}
                title={filename}
            >
                <IconComponent className="h-6 w-6 text-red-500" />
                <div className="text-xs text-red-500 font-medium">Failed to load</div>
            </button>
        );
    }

    return (
        <button
            ref={containerRef}
            onClick={uploadStatus === 'uploading' ? undefined : onClick}
            className={cn(
                "group relative rounded-2xl",
                uploadStatus === 'uploading' ? "cursor-default" : "cursor-pointer",
                "border border-black/10 dark:border-white/10",
                "bg-white dark:bg-neutral-900",
                "p-0 overflow-hidden",
                "flex items-center justify-center",
                isGridLayout ? "w-full aspect-[4/3] min-h-[200px]" : "h-[72px] w-[72px] rounded-xl",
                className,
            )}
            title={uploadStatus === 'uploading' ? 'Uploading...' : filename}
        >
            {/* Upload progress overlay */}
            {(uploadStatus === 'uploading' || (uploadStatus === 'pending' && sandboxId)) && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-20">
                    <KortixLoader size="small" variant="white" />
                </div>
            )}

            {/* Upload error overlay */}
            {uploadStatus === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center bg-red-500/20 z-20">
                    <div className="text-xs text-red-500 font-medium bg-background/90 px-2 py-1 rounded">Failed</div>
                </div>
            )}

            {/* Loading spinner before page renders */}
            {!pageLoaded && isVisible && pdfUrl && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                    <KortixLoader size="small" />
                </div>
            )}

            {/* PDF page 1 thumbnail */}
            {isVisible && pdfUrl && (
                <div className={cn(
                    "flex items-center justify-center overflow-hidden",
                    isGridLayout ? "w-full h-full" : "w-full h-full",
                    !pageLoaded && "opacity-0",
                )}>
                    <Document
                        file={pdfUrl}
                        loading={null}
                        error={null}
                    >
                        <Page
                            pageNumber={1}
                            width={thumbnailWidth}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                            onRenderSuccess={() => setPageLoaded(true)}
                            loading={null}
                        />
                    </Document>
                </div>
            )}

            {/* Fallback icon when not yet visible / no URL */}
            {(!isVisible || !pdfUrl) && !isStillLoading && (
                <IconComponent className="h-6 w-6 text-muted-foreground" />
            )}

            {/* PDF badge overlay */}
            <div className={cn(
                "absolute bottom-1 left-1 z-20",
                "bg-red-600/90 text-white",
                "font-semibold uppercase tracking-wide rounded",
                isGridLayout ? "text-[10px] px-1.5 py-0.5" : "text-[8px] px-1 py-px",
            )}>
                PDF
            </div>
        </button>
    );
}
