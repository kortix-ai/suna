import React, { useState } from 'react';
import { AppIcon } from '../tool-views/shared/AppIcon';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Download, X, Presentation } from 'lucide-react';

export interface SlideInfo {
  presentationName: string;
  slideNumber: number;
  slideTitle: string;
  totalSlides: number;
}

export interface ToolCardProps {
  toolName: string;
  displayName: string;
  toolCall?: any;
  toolCallId?: string;
  paramDisplay?: string | null;
  isStreaming?: boolean;
  onClick?: () => void;
  fallbackIcon?: React.ElementType;
  className?: string;
  websiteUrls?: string[];
  imageUrls?: string[];
  slideInfo?: SlideInfo;
}

const getFavicon = (url: string): string | null => {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return null;
  }
};

const MAX_VISIBLE_IMAGES = 5;

const handleDownload = async (url: string, e: React.MouseEvent) => {
  e.stopPropagation();
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    const filename = url.split('/').pop()?.split('?')[0] || 'image.jpg';
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, '_blank');
  }
};

export const ToolCard: React.FC<ToolCardProps> = ({
  toolName,
  displayName,
  toolCall,
  toolCallId,
  paramDisplay,
  isStreaming = false,
  onClick,
  fallbackIcon,
  className,
  websiteUrls,
  imageUrls,
  slideInfo,
}) => {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const favicons = websiteUrls?.slice(0, 4).map(getFavicon).filter(Boolean) as string[] || [];
  const visibleImages = imageUrls?.slice(0, MAX_VISIBLE_IMAGES) || [];
  const remainingCount = (imageUrls?.length || 0) - MAX_VISIBLE_IMAGES;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <button
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1.5 mt-4 cursor-pointer',
          'text-xs text-muted-foreground hover:opacity-80 transition-opacity duration-200',
          'max-w-full'
        )}
      >
        <div className="flex items-center justify-center flex-shrink-0">
          <AppIcon
            toolCall={toolCall}
            size={14}
            className="h-3.5 w-3.5 text-muted-foreground/90 flex-shrink-0"
            fallbackIcon={fallbackIcon}
          />
        </div>

        <span 
          className={cn(
            "font-medium text-sm text-muted-foreground/90 truncate",
            isStreaming && "shimmer-text-fancy"
          )}
        >
          {displayName}
          {isStreaming && (
            <style>{`
              .shimmer-text-fancy {
                background: linear-gradient(
                  90deg,
                  currentColor 0%,
                  currentColor 40%,
                  rgba(0, 0, 0, 0.7) 48%,
                  rgba(0, 0, 0, 1) 50%,
                  rgba(0, 0, 0, 0.7) 52%,
                  currentColor 60%,
                  currentColor 100%
                );
                background-size: 200% 100%;
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
                animation: shimmerFlowFancy 0.8s linear infinite;
              }
              :root.dark .shimmer-text-fancy,
              .dark .shimmer-text-fancy {
                background: linear-gradient(
                  90deg,
                  currentColor 0%,
                  currentColor 40%,
                  rgba(255, 255, 255, 0.85) 48%,
                  rgba(255, 255, 255, 1) 50%,
                  rgba(255, 255, 255, 0.85) 52%,
                  currentColor 60%,
                  currentColor 100%
                );
                background-size: 200% 100%;
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
              }
              @keyframes shimmerFlowFancy {
                0% { background-position: 100% center; }
                100% { background-position: -100% center; }
              }
            `}</style>
          )}
        </span>

        {paramDisplay && (
          <span
            className="ml-1 text-xs text-muted-foreground truncate max-w-[150px] sm:max-w-[200px]"
            title={paramDisplay}
          >
            {paramDisplay}
          </span>
        )}

        {favicons.length > 0 && (
          <div className="flex items-center ml-1.5 -space-x-1">
            {favicons.map((favicon, idx) => (
              <img
                key={idx}
                src={favicon}
                alt=""
                className="w-4 h-4 rounded-full border border-background bg-background"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ))}
          </div>
        )}
      </button>

      {visibleImages.length > 0 && (
        <div className="flex items-center gap-2 mt-1">
          {visibleImages.map((url, idx) => (
            <button
              key={idx}
              onClick={() => setSelectedImage(url)}
              className="relative w-16 h-16 rounded-lg overflow-hidden bg-muted border border-border flex-shrink-0 hover:opacity-90 transition-opacity cursor-pointer"
            >
              <img
                src={url}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </button>
          ))}
          {remainingCount > 0 && (
            <button
              onClick={onClick}
              className="w-16 h-16 rounded-lg bg-muted border border-border flex items-center justify-center text-xs text-muted-foreground font-medium hover:bg-muted/80 transition-colors flex-shrink-0"
            >
              +{remainingCount}
            </button>
          )}
        </div>
      )}

      {slideInfo && (
        <button
          onClick={onClick}
          className="flex items-center gap-3 mt-1 p-3 border rounded-xl bg-muted/30 border border-border hover:bg-muted/80 transition-colors w-fit max-w-xs"
        >
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-gradient-to-br from-orange-500 to-amber-500 text-white">
            <Presentation className="w-5 h-5" />
          </div>
          <div className="flex flex-col items-start min-w-0">
            <span className="text-sm font-medium text-foreground truncate max-w-[180px]">
              {slideInfo.slideTitle}
            </span>
            <span className="text-xs text-muted-foreground">
              Slide {slideInfo.slideNumber} of {slideInfo.totalSlides} · {slideInfo.presentationName}
            </span>
          </div>
        </button>
      )}

      <Dialog open={!!selectedImage} onOpenChange={(open) => !open && setSelectedImage(null)}>
        <DialogContent 
          className="max-w-4xl p-0 overflow-hidden bg-black/95 border-none"
          hideCloseButton
        >
          {selectedImage && (
            <div className="relative flex flex-col items-center">
              <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
                <button
                  onClick={(e) => handleDownload(selectedImage, e)}
                  className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-white"
                  title="Download"
                >
                  <Download className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setSelectedImage(null)}
                  className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-white"
                  title="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <img
                src={selectedImage}
                alt=""
                className="max-h-[80vh] max-w-full object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

