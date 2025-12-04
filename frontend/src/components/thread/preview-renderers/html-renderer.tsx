'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Code, Monitor, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import type { Project } from '@/lib/api/threads';

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

    // Check if previewUrl is already a valid sandbox preview URL (not an API endpoint)
    const isAlreadySandboxUrl = useMemo(() => {
        // A valid sandbox URL looks like: https://8080-xxx.proxy.daytona.works/index.html
        // It should NOT contain /sandboxes/ or /files/content (which are API patterns)
        if (!previewUrl) return false;
        const isFullUrl = previewUrl.includes('://');
        const isApiEndpoint = previewUrl.includes('/sandboxes/') || previewUrl.includes('/files/content');
        return isFullUrl && !isApiEndpoint;
    }, [previewUrl]);

    // Get full file path from the previewUrl (only needed if it's an API URL)
    const filePath = useMemo(() => {
        // If previewUrl is already a sandbox URL, no need to extract path
        if (isAlreadySandboxUrl) {
            return '';
        }

        try {
            // If it's an API URL (check for various patterns: /api/sandboxes/, /sandboxes/, /v1/sandboxes/)
            if (previewUrl.includes('/sandboxes/') && previewUrl.includes('/files/content')) {
                // Try regex extraction first (works for both full and relative URLs)
                const pathMatch = previewUrl.match(/[?&]path=([^&]+)/);
                if (pathMatch) {
                    const decodedPath = decodeURIComponent(pathMatch[1]);
                    const cleanPath = decodedPath.replace(/^\/workspace\//, '');
                    if (cleanPath) {
                        return cleanPath;
                    }
                }
                
                // Fallback: try URL parsing for full URLs
                if (previewUrl.includes('://')) {
                    const url = new URL(previewUrl);
                    const path = url.searchParams.get('path');
                    if (path) {
                        const decodedPath = decodeURIComponent(path);
                        const cleanPath = decodedPath.replace(/^\/workspace\//, '');
                        if (cleanPath) {
                            return cleanPath;
                        }
                    }
                }
            }

            // If previewUrl is already a simple file path (not a full URL), use it directly
            if (!previewUrl.includes('://') && !previewUrl.includes('/sandboxes/')) {
                // Remove /workspace/ prefix if present
                const cleanPath = previewUrl.replace(/^\/workspace\//, '');
                if (cleanPath) {
                    return cleanPath;
                }
            }

            // If we can't extract a path, return empty string
            return '';
        } catch (e) {
            console.error('Error extracting file path from previewUrl:', e, { previewUrl });
            return '';
        }
    }, [previewUrl, isAlreadySandboxUrl]);

    // Construct HTML file preview URL using the full file path
    const htmlPreviewUrl = useMemo(() => {
        // If previewUrl is already a valid sandbox URL, use it directly
        if (isAlreadySandboxUrl) {
            console.log('[HtmlRenderer] Using previewUrl directly (already sandbox URL):', { previewUrl });
            return previewUrl;
        }

        // Only construct preview URL if we have both sandbox URL and a valid file path
        // filePath should be a simple path like "index.html" or "/workspace/index.html", not a full URL
        if (project?.sandbox?.sandbox_url && filePath && !filePath.includes('://') && !filePath.includes('/sandboxes/')) {
            const constructedUrl = constructHtmlPreviewUrl(project.sandbox.sandbox_url, filePath);
            console.log('[HtmlRenderer] Constructed preview URL:', {
                sandboxUrl: project.sandbox.sandbox_url,
                filePath,
                constructedUrl,
                originalPreviewUrl: previewUrl,
            });
            return constructedUrl;
        }
        
        // Fall back to blob URL if available
        // Never use the API endpoint URL (previewUrl) directly in iframe - it won't work correctly
        if (blobHtmlUrl) {
            console.log('[HtmlRenderer] Falling back to blob URL:', { blobHtmlUrl });
            return blobHtmlUrl;
        }

        console.warn('[HtmlRenderer] Unable to construct preview URL:', {
            previewUrl,
            isAlreadySandboxUrl,
            hasSandboxUrl: !!project?.sandbox?.sandbox_url,
            filePath,
        });
        return undefined;
    }, [project?.sandbox?.sandbox_url, filePath, blobHtmlUrl, isAlreadySandboxUrl, previewUrl]);

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
                        {htmlPreviewUrl ? (
                            <iframe
                                src={htmlPreviewUrl}
                                title="HTML Preview"
                                className="w-full h-full border-0"
                                sandbox="allow-same-origin allow-scripts"
                                style={{ background: 'white' }}
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                                Unable to load HTML preview
                            </div>
                        )}
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