/**
 * PdfPreview - PDF file preview component
 */

import { PdfRenderer } from '@/components/file-renderers';
import { getFileUrl } from '@/lib/utils/file-utils';

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
    const pdfUrl = localPreviewUrl || (sandboxId ? getFileUrl(sandboxId, filepath) : filepath);
    
    if (!pdfUrl) return null;
    
    return (
        <PdfRenderer
            url={pdfUrl}
            className={className || "h-full w-full"}
            compact={true}
        />
    );
}

