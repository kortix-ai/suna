'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Code, Monitor, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import type { Project } from '@/lib/api';

interface HtmlRendererProps {
    content: string;
    previewUrl: string;
    className?: string;
    project?: Project;
}

/**
 * HTML renderer that supports both preview (iframe) and code view modes
 */
export function HtmlRenderer({
    content,
    previewUrl,
    className,
    project
}: HtmlRendererProps) {
    const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

    // Create a blob URL for HTML content if needed
    const blobHtmlUrl = useMemo(() => {
        if (content && !project?.sandbox?.sandbox_url) {
            const blob = new Blob([content], { type: 'text/html' });
            return URL.createObjectURL(blob);
        }
        return undefined;
    }, [content, project?.sandbox?.sandbox_url]);

    // Get full file path from the previewUrl
    const filePath = useMemo(() => {
        try {
            // If it's an API URL, extract the full path from the path parameter
            if (previewUrl.includes('/api/sandboxes/')) {
                const url = new URL(previewUrl);
                const path = url.searchParams.get('path');
                if (path) {
                    // Remove /workspace/ prefix if present
                    return path.replace(/^\/workspace\//, '');
                }
            }

            // Otherwise use the URL as is
            return previewUrl;
        } catch (e) {
            console.error('Error extracting file path:', e);
            return '';
        }
    }, [previewUrl]);

    // Construct HTML file preview URL using the full file path
    const htmlPreviewUrl = useMemo(() => {
        if (project?.sandbox?.sandbox_url && filePath) {
            return constructHtmlPreviewUrl(project.sandbox.sandbox_url, filePath);
        }
        return blobHtmlUrl || previewUrl;
    }, [project?.sandbox?.sandbox_url, filePath, blobHtmlUrl, previewUrl]);

    // Clean up blob URL on unmount
    useEffect(() => {
        return () => {
            if (blobHtmlUrl) {
                URL.revokeObjectURL(blobHtmlUrl);
            }
        };
    }, [blobHtmlUrl]);

    return (
        <div className={cn('w-full h-full flex flex-col', className)}>
            {/* Content area */}
            <div className="flex-1 min-h-0 relative">
                {viewMode === 'preview' ? (
                    <div className="w-full h-full">
                        <iframe
                            src={htmlPreviewUrl}
                            title="HTML Preview"
                            className="w-full h-full border-0"
                            sandbox="allow-same-origin allow-scripts"
                            style={{ background: 'white' }}
                        />
                    </div>
                ) : (
                    <ScrollArea className="w-full h-full">
                        <pre className="p-4 overflow-auto">
                            <code className="text-sm">{content}</code>
                        </pre>
                    </ScrollArea>
                )}
            </div>
        </div>
    );
} 