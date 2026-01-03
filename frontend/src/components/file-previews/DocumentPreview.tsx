/**
 * DocumentPreview - HTML/Markdown/JSON file preview component
 */

import { HtmlRenderer, JsonRenderer } from '@/components/file-renderers';
import { UnifiedMarkdown } from '@/components/markdown';
import { useFileData } from '@/hooks/use-file-data';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { Project } from '@/lib/api/threads';
import { getExtension } from '@/lib/utils/file-types';
import { getFileUrl } from '@/lib/utils/file-utils';
import { cn } from '@/lib/utils';

export interface DocumentPreviewProps {
    filepath: string;
    sandboxId?: string;
    project?: Project;
    className?: string;
}

export function DocumentPreview({
    filepath,
    sandboxId,
    project,
    className,
}: DocumentPreviewProps) {
    const extension = getExtension(filepath);
    const isHtml = extension === 'html' || extension === 'htm';
    const isMarkdown = extension === 'md' || extension === 'markdown';
    const isJson = extension === 'json';
    
    const { data: fileContent, isLoading } = useFileData(
        sandboxId,
        filepath,
        { showPreview: true }
    );
    
    if (isLoading || !fileContent) {
        return (
            <div className={className || "h-full w-full flex items-center justify-center"}>
                <div className="text-muted-foreground">Loading document...</div>
            </div>
        );
    }
    
    // HTML Preview
    if (isHtml) {
        const htmlPreviewUrl = project?.sandbox?.sandbox_url
            ? constructHtmlPreviewUrl(project.sandbox.sandbox_url, filepath)
            : getFileUrl(sandboxId, filepath);
        
        return (
            <HtmlRenderer
                content={fileContent}
                previewUrl={htmlPreviewUrl}
                className={className || "h-full w-full"}
                project={project}
            />
        );
    }
    
    // Markdown Preview
    if (isMarkdown) {
        return (
            <div className={cn(className || "h-full w-full overflow-auto p-4")}>
                <UnifiedMarkdown content={fileContent} />
            </div>
        );
    }
    
    // JSON Preview
    if (isJson) {
        return (
            <JsonRenderer content={fileContent} />
        );
    }
    
    return null;
}

