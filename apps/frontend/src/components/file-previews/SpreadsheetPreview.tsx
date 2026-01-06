/**
 * SpreadsheetPreview - XLSX/CSV file preview component
 */

import dynamic from 'next/dynamic';
import { useFileData } from '@/hooks/use-file-data';
import { Project } from '@/lib/api/threads';

const SpreadsheetViewer = dynamic(
    () => import('@/components/thread/tool-views/spreadsheet/SpreadsheetViewer').then((mod) => mod.SpreadsheetViewer),
    { ssr: false, loading: () => <div className="p-4 text-muted-foreground">Loading spreadsheet...</div> }
);

export interface SpreadsheetPreviewProps {
    filepath: string;
    sandboxId?: string;
    project?: Project;
    className?: string;
}

export function SpreadsheetPreview({
    filepath,
    sandboxId,
    project,
    className,
}: SpreadsheetPreviewProps) {
    const filename = filepath.split('/').pop() || '';
    
    const { data: blobUrl, isLoading } = useFileData(
        sandboxId,
        filepath,
        { showPreview: true }
    );
    
    if (isLoading || !blobUrl) {
        return (
            <div className={className || "h-full w-full flex items-center justify-center"}>
                <div className="text-muted-foreground">Loading spreadsheet...</div>
            </div>
        );
    }
    
    return (
        <SpreadsheetViewer
            filePath={filepath}
            fileName={filename}
            sandboxId={sandboxId}
            project={project}
            className={className || "h-full w-full"}
            compact={true}
            showToolbar={false}
            allowEditing={false}
        />
    );
}

