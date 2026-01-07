import React, { useState, useEffect, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface PresentationSlideSkeletonProps {
  slideNumber: number;
  isGenerating?: boolean;
  slideTitle?: string;
  /** Streaming HTML content to render live as it's being generated */
  streamingContent?: string;
  className?: string;
}

/**
 * Empty slide placeholder that can show real-time streaming content.
 * No loading states - just empty frames that fill in with actual content.
 */
export function PresentationSlideSkeleton({
  slideNumber,
  isGenerating = false,
  slideTitle,
  streamingContent,
  className = '',
}: PresentationSlideSkeletonProps) {
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  // Calculate scale for the iframe to fit the container
  useEffect(() => {
    if (!containerRef) return;

    const updateScale = () => {
      const containerWidth = containerRef.offsetWidth;
      const containerHeight = containerRef.offsetHeight;
      const scaleX = containerWidth / 1920;
      const scaleY = containerHeight / 1080;
      setScale(Math.min(scaleX, scaleY));
    };

    updateScale();
    const resizeObserver = new ResizeObserver(updateScale);
    resizeObserver.observe(containerRef);

    return () => resizeObserver.disconnect();
  }, [containerRef]);

  // Build the full HTML document for the streaming content
  const streamingHtmlDoc = useMemo(() => {
    if (!streamingContent) return null;
    
    // Wrap the content in a basic HTML structure with presentation styling
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { 
      width: 1920px; 
      height: 1080px; 
      overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
    }
    body { padding: 60px; }
  </style>
</head>
<body>
${streamingContent}
</body>
</html>`;
  }, [streamingContent]);

  const hasContent = !!streamingContent && streamingContent.trim().length > 0;

  return (
    <div 
      className={cn(
        'group relative bg-background border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden',
        isGenerating && 'ring-2 ring-blue-500/30',
        className
      )}
    >
      {/* Slide header */}
      <div className="px-3 py-2 bg-muted/20 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge 
            variant="outline" 
            className={cn(
              'h-6 px-2 text-xs font-mono',
              isGenerating && 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
            )}
          >
            #{slideNumber}
          </Badge>
          {slideTitle ? (
            <span className="text-sm text-muted-foreground truncate">
              {slideTitle}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground/40">
              —
            </span>
          )}
        </div>
        {isGenerating && (
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded-full border border-blue-300 border-t-blue-500 animate-spin" />
          </div>
        )}
      </div>
      
      {/* Slide Preview - Empty frame or streaming content */}
      <div className="relative aspect-video">
        <div 
          ref={setContainerRef}
          className={cn(
            'w-full h-full relative overflow-hidden',
            !hasContent && 'bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900'
          )}
        >
          {hasContent && streamingHtmlDoc ? (
            // Render streaming HTML content in real-time
            <iframe
              srcDoc={streamingHtmlDoc}
              title={`Slide ${slideNumber} (generating)`}
              className="border-0"
              sandbox="allow-same-origin"
              style={{
                width: '1920px',
                height: '1080px',
                border: 'none',
                display: 'block',
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
                position: 'absolute',
                top: 0,
                left: 0,
              }}
            />
          ) : (
            // Empty slide frame - no loading indicators
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center opacity-20">
                <span className="text-6xl font-bold text-zinc-400 dark:text-zinc-600">
                  {slideNumber}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

