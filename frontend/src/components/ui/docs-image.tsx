'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ZoomIn, ExternalLink, Download } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DocsImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'size'> {
  caption?: string;
  credit?: string;
  badge?: string;
  badgeVariant?: 'default' | 'secondary' | 'destructive' | 'outline';
  size?: 'sm' | 'default' | 'lg' | 'xl' | 'full';
  aspect?: 'square' | 'video' | 'wide' | 'tall' | 'auto';
  rounded?: boolean;
  shadow?: boolean;
  border?: boolean;
  zoom?: boolean;
  download?: boolean;
  external?: boolean;
  loading?: 'lazy' | 'eager';
  placeholder?: string;
  containerClassName?: string;
  captionClassName?: string;
  onZoom?: () => void;
  onDownload?: () => void;
  onExternal?: () => void;
}

export const DocsImage = React.forwardRef<HTMLDivElement, DocsImageProps>(
  ({
    src,
    alt,
    caption,
    credit,
    badge,
    badgeVariant = 'secondary',
    size = 'default',
    aspect = 'auto',
    rounded = true,
    shadow = false,
    border = false,
    zoom = false,
    download = false,
    external = false,
    loading = 'lazy',
    placeholder,
    containerClassName,
    captionClassName,
    className,
    onZoom,
    onDownload,
    onExternal,
    ...props
  }, ref) => {
    const [imageLoading, setImageLoading] = React.useState(true);
    const [imageError, setImageError] = React.useState(false);

    const sizeClasses = {
      sm: 'w-full max-w-sm',
      default: 'w-full max-w-md',
      lg: 'w-full max-w-lg',
      xl: 'w-full max-w-xl',
      full: 'w-full'
    };

    const aspectClasses = {
      square: 'aspect-square',
      video: 'aspect-video',
      wide: 'aspect-[16/9]',
      tall: 'aspect-[4/5]',
      auto: ''
    };

    const handleImageLoad = () => {
      setImageLoading(false);
    };

    const handleImageError = () => {
      setImageLoading(false);
      setImageError(true);
    };

    const handleZoom = () => {
      if (onZoom) {
        onZoom();
      } else {
        // Default zoom behavior - open in new tab
        window.open(src, '_blank');
      }
    };

    const handleDownload = () => {
      if (onDownload) {
        onDownload();
      } else {
        // Default download behavior
        const link = document.createElement('a');
        link.href = src || '';
        link.download = alt || 'image';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    };

    return (
      <figure 
        ref={ref} 
        className={cn("relative group", containerClassName)}
      >
        <div className={cn(
          "relative overflow-hidden border border-muted/50",
          sizeClasses[size],
          aspectClasses[aspect],
          rounded && "rounded-lg",
          border && "border",
          shadow && "shadow-md",
          className
        )}>
          {badge && (
            <Badge 
              variant={badgeVariant}
              className="absolute top-2 left-2 z-10"
            >
              {badge}
            </Badge>
          )}
          {(zoom || download || external) && (
            <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="flex gap-1">
                {zoom && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={handleZoom}
                  >
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                )}
                {external && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={onExternal}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                )}
                {download && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={handleDownload}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Loading placeholder */}
          {imageLoading && (
            <div className="absolute inset-0 bg-muted animate-pulse flex items-center justify-center">
              {placeholder ? (
                <span className="text-muted-foreground text-sm">{placeholder}</span>
              ) : (
                <div className="w-8 h-8 bg-muted-foreground/20 rounded" />
              )}
            </div>
          )}

          {/* Error state */}
          {imageError && (
            <div className="absolute inset-0 bg-muted flex items-center justify-center">
              <span className="text-muted-foreground text-sm">Failed to load image</span>
            </div>
          )}

          {/* Image */}
          {src && !imageError && (
            <img
              src={src}
              alt={alt || caption || 'Documentation image'}
              loading={loading}
              onLoad={handleImageLoad}
              onError={handleImageError}
              className={cn(
                "w-full h-full object-cover transition-transform",
                zoom && "group-hover:scale-105 cursor-zoom-in",
                imageLoading && "opacity-0"
              )}
              {...props}
            />
          )}
        </div>

        {/* Caption */}
        {(caption || credit) && (
          <figcaption className={cn(
            "mt-2 text-sm text-muted-foreground text-center space-y-1",
            captionClassName
          )}>
            {caption && (
              <p className="leading-relaxed">{caption}</p>
            )}
            {credit && (
              <p className="text-xs italic">Credit: {credit}</p>
            )}
          </figcaption>
        )}
      </figure>
    );
  }
);

DocsImage.displayName = 'DocsImage'; 