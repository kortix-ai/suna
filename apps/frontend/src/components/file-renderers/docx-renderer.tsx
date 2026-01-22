/**
 * DocxRenderer - Renders DOCX files using docx-preview library
 */

'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { KortixLoader } from '@/components/ui/kortix-loader';

interface DocxRendererProps {
    url?: string;
    blob?: Blob;
    className?: string;
}

export function DocxRenderer({ url, blob, className }: DocxRendererProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isRendering, setIsRendering] = useState(false);
    const [isRendered, setIsRendered] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Store the blob data to avoid re-fetching
    const blobRef = useRef<Blob | null>(null);

    // Debug logging
    useEffect(() => {
        console.log('[DocxRenderer] Props:', {
            url,
            hasBlob: blob instanceof Blob,
            blobSize: blob instanceof Blob ? blob.size : null,
            isRendering,
            isRendered,
            error,
            containerReady: !!containerRef.current,
        });
    }, [url, blob, isRendering, isRendered, error]);

    const renderDocx = useCallback(async () => {
        // Skip if already rendering or rendered
        if (isRendering || isRendered) {
            console.log('[DocxRenderer] Skipping render - already rendering or rendered');
            return;
        }

        const container = containerRef.current;
        if (!container) {
            console.log('[DocxRenderer] Container ref not ready, will retry');
            return;
        }

        // Need either url or blob
        if (!url && !blob) {
            console.log('[DocxRenderer] No url or blob provided yet');
            return;
        }

        setIsRendering(true);
        setError(null);

        try {
            let docxBlob: Blob;

            if (blob) {
                console.log('[DocxRenderer] Using provided blob, size:', blob.size);
                docxBlob = blob;
            } else if (blobRef.current) {
                console.log('[DocxRenderer] Using cached blob, size:', blobRef.current.size);
                docxBlob = blobRef.current;
            } else if (url) {
                console.log('[DocxRenderer] Fetching from URL:', url);
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error('Failed to fetch document');
                }
                docxBlob = await response.blob();
                blobRef.current = docxBlob;
                console.log('[DocxRenderer] Fetched blob, size:', docxBlob.size);
            } else {
                throw new Error('No document source provided');
            }

            console.log('[DocxRenderer] Importing docx-preview library...');
            // Dynamically import docx-preview to avoid SSR issues
            const { renderAsync } = await import('docx-preview');
            console.log('[DocxRenderer] Library imported, rendering...');

            // Check container is still mounted
            if (!containerRef.current) {
                console.log('[DocxRenderer] Container unmounted during fetch, aborting');
                setIsRendering(false);
                return;
            }

            // Clear previous content
            containerRef.current.innerHTML = '';

            // Render DOCX to container
            // inWrapper: false - no paper wrapper, just content
            // ignoreWidth: true - fill container width instead of page width
            // ignoreHeight: true - no page height constraints
            // breakPages: false - continuous scroll, no page breaks
            await renderAsync(docxBlob, containerRef.current, containerRef.current, {
                className: 'docx-preview',
                inWrapper: false,
                ignoreWidth: true,
                ignoreHeight: true,
                ignoreFonts: false,
                breakPages: false,
                ignoreLastRenderedPageBreak: true,
                experimental: false,
                trimXmlDeclaration: true,
                useBase64URL: true,
                renderHeaders: true,
                renderFooters: true,
                renderFootnotes: true,
                renderEndnotes: true,
            });

            console.log('[DocxRenderer] Rendered successfully');
            setIsRendered(true);
        } catch (err) {
            console.error('[DocxRenderer] Error:', err);
            setError(err instanceof Error ? err.message : 'Failed to render document');
        } finally {
            setIsRendering(false);
        }
    }, [url, blob, isRendering, isRendered]);

    // Trigger render when container becomes available or dependencies change
    useEffect(() => {
        if (containerRef.current && (url || blob) && !isRendered && !isRendering) {
            renderDocx();
        }
    }, [url, blob, isRendered, isRendering, renderDocx]);

    // Reset when url/blob changes
    useEffect(() => {
        setIsRendered(false);
        setError(null);
        blobRef.current = null;
    }, [url, blob]);

    // Show error state
    if (error) {
        return (
            <div className={cn("flex items-center justify-center h-full w-full", className)}>
                <div className="text-sm text-muted-foreground">{error}</div>
            </div>
        );
    }

    // Always render the container, overlay loading state on top
    // This keeps the ref stable so docx-preview can render into it
    return (
        <div className={cn("relative h-full w-full", className)}>
            {/* Loading overlay */}
            {(!isRendered || isRendering) && (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/50 z-10">
                    <KortixLoader size="medium" />
                </div>
            )}

            {/* DOCX container - always mounted to keep ref stable */}
            <div
                ref={containerRef}
                className={cn(
                    "h-full w-full overflow-auto bg-white docx-container",
                    !isRendered && "invisible" // Hide until rendered
                )}
            />
        </div>
    );
}
