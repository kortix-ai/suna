import React, { useState, useEffect, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Maximize2, Presentation } from 'lucide-react';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { Project } from '@/lib/api/threads';

interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

interface PresentationSlideCardProps {
  slide: SlideMetadata & { number: number };
  project?: Project;
  onFullScreenClick?: (slideNumber: number) => void;
  className?: string;
  showFullScreenButton?: boolean;
  refreshTimestamp?: number;
}

export function PresentationSlideCard({
  slide,
  project,
  onFullScreenClick,
  className = '',
  showFullScreenButton = true,
  refreshTimestamp,
}: PresentationSlideCardProps) {
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  const slidePreviewUrl = useMemo(() => {
    if (!project?.sandbox?.sandbox_url) return null;
    const url = constructHtmlPreviewUrl(project.sandbox.sandbox_url, slide.file_path);
    return refreshTimestamp ? `${url}?t=${refreshTimestamp}` : url;
  }, [project?.sandbox?.sandbox_url, slide.file_path, refreshTimestamp]);

  useEffect(() => {
    if (!containerRef) return;

    const updateScale = () => {
      const containerWidth = containerRef.offsetWidth;
      const containerHeight = containerRef.offsetHeight;
      
      // Calculate scale to fit 1920x1080 into container while maintaining aspect ratio
      const scaleX = containerWidth / 1920;
      const scaleY = containerHeight / 1080;
      const newScale = Math.min(scaleX, scaleY);
      
      // Only update if scale actually changed to prevent unnecessary re-renders
      if (Math.abs(newScale - scale) > 0.001) {
        setScale(newScale);
      }
    };

    // Initial scale calculation
    updateScale();

    // Use ResizeObserver to watch for container size changes (catches both window and panel resizes)
    let resizeTimeout: NodeJS.Timeout;
    const debouncedUpdateScale = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateScale, 50); // Reduced debounce for smoother resizing
    };

    const resizeObserver = new ResizeObserver(debouncedUpdateScale);
    resizeObserver.observe(containerRef);

    // Also listen to window resize as fallback
    window.addEventListener('resize', debouncedUpdateScale);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', debouncedUpdateScale);
      clearTimeout(resizeTimeout);
    };
  }, [containerRef, scale]);

  if (!slidePreviewUrl) {
    return (
      <div className={`group relative bg-background border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden ${className}`}>
        <div className="px-3 py-2 bg-muted/20 border-b border-border/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="h-6 px-2 text-xs font-mono">
              #{slide.number}
            </Badge>
            {slide.title && (
              <span className="text-sm text-muted-foreground truncate">
                {slide.title}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-center h-48 bg-muted/30">
          <div className="text-center">
            <Presentation className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No slide content to preview</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      className={`group relative bg-background border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden hover:shadow-lg hover:shadow-black/5 dark:hover:shadow-black/20 hover:scale-[1.01] transition-all duration-200 ${className}`}
    >
      {/* Slide header */}
      <div className="px-3 py-2 bg-muted/20 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="h-6 px-2 text-xs font-mono">
            #{slide.number}
          </Badge>
          {slide.title && (
            <span className="text-sm text-muted-foreground truncate">
              {slide.title}
            </span>
          )}
        </div>
        {showFullScreenButton !== false && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFullScreenClick?.(slide.number)}
            className="h-8 w-8 p-0 opacity-60 group-hover:opacity-100 transition-opacity"
            title="Open in full screen"
            disabled={!onFullScreenClick}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      
      {/* Slide Preview */}
      <div 
        className="relative aspect-video bg-muted/30 cursor-pointer"
        onClick={() => onFullScreenClick?.(slide.number)}
      >
        <div className="w-full h-full flex items-center justify-center bg-transparent">
          <div 
            ref={setContainerRef}
            className="relative w-full h-full bg-background rounded-lg overflow-hidden"
            style={{
              containIntrinsicSize: '1920px 1080px',
              contain: 'layout style'
            }}
          >
            <iframe
              key={`slide-${slide.number}-${refreshTimestamp || slide.file_path}`}
              src={slidePreviewUrl}
              title={`Slide ${slide.number}: ${slide.title}`}
              className="border-0 rounded-xl"
              sandbox="allow-same-origin allow-scripts"
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
                willChange: 'transform',
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden'
              }}
            />
          </div>
        </div>
        
        {/* Subtle hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors duration-200" />
      </div>
    </div>
  );
}

