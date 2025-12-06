'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { CodeEditor } from '@/components/file-editors';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Monitor, Code, ExternalLink } from 'lucide-react';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';

interface FileRendererProject {
  id?: string;
  name?: string;
  description?: string;
  created_at?: string;
  sandbox?: {
    id?: string;
    sandbox_url?: string;
    vnc_preview?: string;
    pass?: string;
  };
}

interface HtmlRendererProps {
  content: string;
  previewUrl: string;
  className?: string;
  project?: FileRendererProject;
}

export function HtmlRenderer({
  content,
  previewUrl,
  className,
  project,
}: HtmlRendererProps) {
  // Always default to 'preview' mode
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

  // Check if previewUrl is already a valid sandbox preview URL (not an API endpoint)
  const isAlreadySandboxUrl = useMemo(() => {
    if (!previewUrl) return false;
    const isFullUrl = previewUrl.includes('://');
    const isApiEndpoint = previewUrl.includes('/sandboxes/') || previewUrl.includes('/files/content');
    return isFullUrl && !isApiEndpoint;
  }, [previewUrl]);

  // Create a blob URL for HTML content if no sandbox is available (fallback)
  const blobHtmlUrl = useMemo(() => {
    if (content && !project?.sandbox?.sandbox_url && !isAlreadySandboxUrl) {
      const blob = new Blob([content], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }
    return undefined;
  }, [content, project?.sandbox?.sandbox_url, isAlreadySandboxUrl]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobHtmlUrl) {
        URL.revokeObjectURL(blobHtmlUrl);
      }
    };
  }, [blobHtmlUrl]);

  // Extract file path from previewUrl if it's a full API URL
  const filePath = useMemo(() => {
    // If previewUrl is already a sandbox URL, no need to extract path
    if (isAlreadySandboxUrl) {
      return '';
    }

    try {
      // If it's an API URL (check for various patterns: /api/sandboxes/, /sandboxes/, /v1/sandboxes/)
      if (previewUrl.includes('/sandboxes/') && previewUrl.includes('/files/content')) {
        // Try to extract path parameter from query string
        const pathMatch = previewUrl.match(/[?&]path=([^&]+)/);
        if (pathMatch) {
          const decodedPath = decodeURIComponent(pathMatch[1]);
          // Remove /workspace/ prefix if present
          const cleanPath = decodedPath.replace(/^\/workspace\//, '');
          if (cleanPath) {
            return cleanPath;
          }
        }
        
        // Fallback: try parsing as URL if it's a full URL
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

  // Construct HTML file preview URL using the sandbox URL and file path
  const htmlPreviewUrl = useMemo(() => {
    // If previewUrl is already a valid sandbox URL, use it directly
    if (isAlreadySandboxUrl) {
      return previewUrl;
    }

    // Construct preview URL if we have both sandbox URL and a valid file path
    if (project?.sandbox?.sandbox_url && filePath && !filePath.includes('://') && !filePath.includes('/sandboxes/')) {
      const constructedUrl = constructHtmlPreviewUrl(project.sandbox.sandbox_url, filePath);
      return constructedUrl;
    }

    // Fall back to blob URL if available
    if (blobHtmlUrl) {
      return blobHtmlUrl;
    }

    // If previewUrl looks like a valid URL (not an API endpoint), use it directly
    if (previewUrl && !previewUrl.includes('/sandboxes/') && !previewUrl.includes('/files/content')) {
      return previewUrl;
    }

    // No valid preview URL available
    return '';
  }, [project?.sandbox?.sandbox_url, filePath, previewUrl, isAlreadySandboxUrl, blobHtmlUrl]);

  return (
    <div className={cn('w-full h-full flex flex-col', className)}>
      {/* Content area */}
      <div className="flex-1 min-h-0 relative">
        {/* View mode toggle */}
        <div className="absolute left-2 top-2 z-10 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'flex items-center gap-2 bg-background/80 backdrop-blur-sm hover:bg-background/90',
              viewMode === 'preview' && 'bg-background/90',
            )}
            onClick={() => setViewMode('preview')}
          >
            <Monitor className="h-4 w-4" />
            Preview
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'flex items-center gap-2 bg-background/80 backdrop-blur-sm hover:bg-background/90',
              viewMode === 'code' && 'bg-background/90',
            )}
            onClick={() => setViewMode('code')}
          >
            <Code className="h-4 w-4" />
            Code
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex items-center gap-2 bg-background/80 backdrop-blur-sm hover:bg-background/90"
            onClick={() => window.open(htmlPreviewUrl || previewUrl, '_blank')}
            disabled={!htmlPreviewUrl && !previewUrl}
          >
            <ExternalLink className="h-4 w-4" />
            Open
          </Button>
        </div>

        {viewMode === 'preview' ? (
          <div className="absolute inset-0">
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
          <div className="absolute inset-0 overflow-auto">
            <CodeEditor
              content={content}
              fileName="preview.html"
              readOnly={true}
              className="w-full min-h-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}
