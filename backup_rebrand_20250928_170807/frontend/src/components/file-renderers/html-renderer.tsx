'use client';

import React, { useState } from 'react';
import { CodeRenderer } from './code-renderer';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Monitor, Code, ExternalLink } from 'lucide-react';

interface HtmlRendererProps {
  content: string;
  previewUrl: string;
  className?: string;
}

export function HtmlRenderer({
  content,
  previewUrl,
  className,
}: HtmlRendererProps) {
  // Always default to 'preview' mode
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

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
            onClick={() => window.open(previewUrl, '_blank')}
          >
            <ExternalLink className="h-4 w-4" />
            Open
          </Button>
        </div>

        {viewMode === 'preview' ? (
          <div className="absolute inset-0">
            <iframe
              src={previewUrl}
              title="HTML Preview"
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        ) : (
          <div className="absolute inset-0">
            <CodeRenderer
              content={content}
              language="html"
              className="w-full h-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}
