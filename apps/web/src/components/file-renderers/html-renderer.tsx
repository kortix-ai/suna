'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { CodeEditor } from '@/components/file-editors';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Monitor, Code, ExternalLink } from 'lucide-react';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { IframePreview } from '@/components/thread/iframe-preview';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';

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
  const { subdomainOpts } = useSandboxProxy();
  // Always default to 'preview' mode
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

  // Create a blob URL for HTML content if no sandbox is available (fallback)
  const blobHtmlUrl = useMemo(() => {
    if (content && !project?.sandbox?.sandbox_url) {
      const blob = new Blob([content], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }
    return undefined;
  }, [content, project?.sandbox?.sandbox_url]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobHtmlUrl) {
        URL.revokeObjectURL(blobHtmlUrl);
      }
    };
  }, [blobHtmlUrl]);

  // Extract file path from previewUrl — just strip /workspace/ prefix
  const filePath = useMemo(() => {
    if (!previewUrl) return '';
    // If it's a full URL already, no path to extract
    if (previewUrl.includes('://')) return '';
    // Remove /workspace/ prefix if present
    return previewUrl.replace(/^\/workspace\//, '');
  }, [previewUrl]);

  // Construct HTML file preview URL
  const htmlPreviewUrl = useMemo(() => {
    // If previewUrl is already a full URL, use it directly
    if (previewUrl && previewUrl.includes('://')) {
      return previewUrl;
    }

    // Construct preview URL if we have a valid file path
    if (filePath) {
      return constructHtmlPreviewUrl(filePath, subdomainOpts);
    }

    // Fall back to blob URL if available
    if (blobHtmlUrl) {
      return blobHtmlUrl;
    }

    // If previewUrl exists, use it directly
    if (previewUrl) {
      return previewUrl;
    }

    // No valid preview URL available
    return '';
  }, [project?.sandbox?.sandbox_url, filePath, previewUrl, blobHtmlUrl, subdomainOpts]);

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
              <IframePreview
                url={htmlPreviewUrl}
                title="HTML Preview"
                className="w-full h-full"
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
