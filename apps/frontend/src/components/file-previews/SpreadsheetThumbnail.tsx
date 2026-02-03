/**
 * SpreadsheetThumbnail - Lightweight spreadsheet first-rows thumbnail preview
 * Parses and renders a mini table of the first few rows using xlsx, with lazy loading.
 */

'use client';

import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { cn } from '@/lib/utils';
import { getFilename, getFileIcon } from '@/lib/utils/file-utils';
import { useFileContentQuery } from '@/hooks/files/use-file-queries';
import { KortixLoader } from '@/components/ui/kortix-loader';

// Constants for thumbnail preview
const MAX_ROWS = 5;
const MAX_COLS = 4;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB - skip parsing for larger files

export interface SpreadsheetThumbnailProps {
    filepath: string;
    sandboxId?: string;
    localPreviewUrl?: string;
    onClick?: () => void;
    className?: string;
    uploadStatus?: 'pending' | 'uploading' | 'ready' | 'error';
    isGridLayout?: boolean;
}

export function SpreadsheetThumbnail({
    filepath,
    sandboxId,
    localPreviewUrl,
    onClick,
    className,
    uploadStatus,
    isGridLayout = false,
}: SpreadsheetThumbnailProps) {
    const filename = getFilename(filepath);
    const extension = filename.split('.').pop()?.toLowerCase() || 'xlsx';
    const IconComponent = getFileIcon('spreadsheet');

    // Lazy loading: only parse when the element is visible
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

    // Parse spreadsheet data
    const [tableData, setTableData] = useState<string[][] | null>(null);
    const [parseError, setParseError] = useState(false);

    // Parse from localPreviewUrl (File blob URL)
    useEffect(() => {
        if (!localPreviewUrl || !isVisible) return;

        let cancelled = false;

        (async () => {
            try {
                const response = await fetch(localPreviewUrl);
                const arrayBuffer = await response.arrayBuffer();

                // Skip parsing for very large files to prevent browser freeze
                if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
                    if (!cancelled) setParseError(true);
                    return;
                }

                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1 });

                if (!cancelled) {
                    const preview = rows.slice(0, MAX_ROWS).map(row =>
                        (row || []).slice(0, MAX_COLS).map(cell => String(cell ?? ''))
                    );
                    setTableData(preview);
                }
            } catch (e) {
                if (!cancelled) setParseError(true);
            }
        })();

        return () => { cancelled = true; };
    }, [localPreviewUrl, isVisible]);

    // Parse from sandbox blob
    useEffect(() => {
        if (!blobData || !(blobData instanceof Blob) || localPreviewUrl) return;

        let cancelled = false;

        (async () => {
            try {
                const arrayBuffer = await blobData.arrayBuffer();

                // Skip parsing for very large files to prevent browser freeze
                if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
                    if (!cancelled) setParseError(true);
                    return;
                }

                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1 });

                if (!cancelled) {
                    const preview = rows.slice(0, MAX_ROWS).map(row =>
                        (row || []).slice(0, MAX_COLS).map(cell => String(cell ?? ''))
                    );
                    setTableData(preview);
                }
            } catch (e) {
                if (!cancelled) setParseError(true);
            }
        })();

        return () => { cancelled = true; };
    }, [blobData, localPreviewUrl]);

    const hasError = (error && (failureCount || 0) >= 15) || parseError;
    const isStillLoading = (isLoading || (!tableData && !hasError && !localPreviewUrl)) && needsSandboxFetch;
    const hasData = tableData && tableData.length > 0;

    // Badge text based on extension
    const badgeText = extension === 'csv' ? 'CSV' : extension === 'tsv' ? 'TSV' : 'XLSX';
    const badgeColor = extension === 'csv' || extension === 'tsv' ? 'bg-green-600/90' : 'bg-emerald-600/90';

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
                title="Loading spreadsheet..."
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

            {/* Loading spinner before data parses */}
            {!hasData && isVisible && (localPreviewUrl || blobData) && !hasError && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                    <KortixLoader size="small" />
                </div>
            )}

            {/* Mini table preview */}
            {hasData && (
                <div className={cn(
                    "w-full h-full overflow-hidden",
                    isGridLayout ? "p-2" : "p-1",
                )}>
                    <table className={cn(
                        "w-full h-full border-collapse",
                        isGridLayout ? "text-[10px]" : "text-[6px]",
                    )}>
                        <tbody>
                            {tableData.map((row, rowIdx) => (
                                <tr key={rowIdx} className={rowIdx === 0 ? "font-semibold bg-muted/30" : ""}>
                                    {row.map((cell, colIdx) => (
                                        <td
                                            key={colIdx}
                                            className={cn(
                                                "border border-border/30 truncate max-w-0",
                                                isGridLayout ? "px-1 py-0.5" : "px-0.5",
                                            )}
                                            style={{ maxWidth: isGridLayout ? '80px' : '16px' }}
                                        >
                                            {cell}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Fallback icon when not yet visible / no data */}
            {(!isVisible || (!hasData && !isStillLoading && !localPreviewUrl && !blobData)) && (
                <IconComponent className="h-6 w-6 text-muted-foreground" />
            )}

            {/* File type badge overlay */}
            <div className={cn(
                "absolute bottom-1 left-1 z-20",
                badgeColor,
                "text-white",
                "font-semibold uppercase tracking-wide rounded",
                isGridLayout ? "text-[10px] px-1.5 py-0.5" : "text-[8px] px-1 py-px",
            )}>
                {badgeText}
            </div>
        </button>
    );
}
