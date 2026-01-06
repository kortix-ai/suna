/**
 * PdfPreview - PDF file preview component
 */

import React from 'react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { PdfRenderer } from '@/components/file-renderers';
import { useFileContentQuery } from '@/hooks/files/use-file-queries';
import { cn } from '@/lib/utils';

export interface PdfPreviewProps {
    filepath: string;
    sandboxId?: string;
    localPreviewUrl?: string;
    className?: string;
}

export function PdfPreview({
    filepath,
    sandboxId,
    localPreviewUrl,
    className,
}: PdfPreviewProps) {
    const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
    
    // Directly use useFileContentQuery for PDFs to ensure blob type
    const { data: blobData, isLoading, error, failureCount } = useFileContentQuery(
        sandboxId,
        filepath,
        { 
            contentType: 'blob',
            enabled: !localPreviewUrl && !!sandboxId && !!filepath,
        }
    );
    
    // Create blob URL when data is available
    React.useEffect(() => {
        if (blobData instanceof Blob) {
            // Debug: Check blob contents
            console.log('[PdfPreview] Blob received:', {
                type: blobData.type,
                size: blobData.size,
            });
            
            // Read first few bytes to verify it's a PDF
            const reader = new FileReader();
            reader.onload = () => {
                const arr = new Uint8Array(reader.result as ArrayBuffer);
                const header = String.fromCharCode(...arr.slice(0, 8));
                console.log('[PdfPreview] File header:', header);
                
                // Check if it starts with %PDF
                if (!header.startsWith('%PDF')) {
                    console.error('[PdfPreview] Invalid PDF header! Got:', header);
                    // Log more of the content for debugging
                    const text = new TextDecoder().decode(arr.slice(0, 200));
                    console.error('[PdfPreview] First 200 chars:', text);
                }
            };
            reader.readAsArrayBuffer(blobData.slice(0, 200));
            
            // Create blob URL with explicit PDF type
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
    const retryCount = failureCount || 0;
    
    // Debug logging for PDF data
    console.log('[PdfPreview] State:', {
        filepath,
        sandboxId,
        localPreviewUrl,
        blobUrl,
        pdfUrl,
        isLoading,
        error: error?.message,
        retryCount
    });
    
    // Show loading state while fetching with auth
    if ((isLoading || !blobUrl) && !localPreviewUrl && !error) {
        return (
            <div className={cn(
                "flex flex-col items-center justify-center h-full w-full bg-muted/20",
                className
            )}>
                <KortixLoader size="medium" />
                {retryCount > 0 && (
                    <div className="text-xs text-muted-foreground mt-2">
                        Loading... (attempt {retryCount + 1})
                    </div>
                )}
            </div>
        );
    }
    
    // Show error state after retries exhausted
    if (error && !isLoading && failureCount >= 15) {
        return (
            <div className={cn(
                "flex flex-col items-center justify-center h-full w-full bg-muted/20",
                className
            )}>
                <div className="text-sm text-muted-foreground">Failed to load PDF</div>
            </div>
        );
    }
    
    if (!pdfUrl) return null;
    
    return (
        <PdfRenderer
            url={pdfUrl}
            className={className || "h-full w-full"}
            compact={true}
        />
    );
}

