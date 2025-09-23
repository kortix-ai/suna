'use client';

import React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { MarkdownRenderer as FileMarkdownRenderer } from '@/components/file-renderers/authenticated-markdown-renderer';
import type { Project } from '@/lib/api';

interface MarkdownRendererProps {
    content: string;
    className?: string;
    project?: Project;
    previewUrl?: string;
    basePath?: string;
}

/**
 * Renderer for Markdown content with scrollable container
 * Now uses the FileMarkdownRenderer with image authentication support
 */
export function MarkdownRenderer({
    content,
    className,
    project,
    previewUrl,
    basePath
}: MarkdownRendererProps) {
    // Derive basePath from previewUrl if not explicitly provided
    let derivedBasePath = basePath;
    try {
        if (!derivedBasePath && previewUrl) {
            if (previewUrl.includes('/api/sandboxes/')) {
                const u = new URL(previewUrl);
                const p = u.searchParams.get('path');
                if (p) derivedBasePath = p;
            } else {
                derivedBasePath = previewUrl;
            }
        }
    } catch {}
    return (
        <div className={cn('w-full h-full overflow-hidden', className)}>
            <ScrollArea className="w-full h-full">
                <div className="p-4">
                    <FileMarkdownRenderer
                        content={content}
                        className="prose prose-sm dark:prose-invert max-w-none [&>:first-child]:mt-0"
                        project={project}
                        basePath={derivedBasePath}
                    />
                </div>
            </ScrollArea>
        </div>
    );
} 