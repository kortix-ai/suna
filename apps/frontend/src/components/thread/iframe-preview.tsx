'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface IframePreviewProps {
  url: string;
  title?: string;
  className?: string;
}

export function IframePreview({
  url,
  title,
  className,
}: IframePreviewProps) {
  const [isLoading, setIsLoading] = React.useState(true);
  const [hasError, setHasError] = React.useState(false);

  return (
    <>
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
        </div>
      )}

      {/* Error state */}
      {hasError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-muted/30">
          <div className="text-muted-foreground font-medium mb-1">Unable to load preview</div>
          <div className="text-muted-foreground text-sm text-center mb-4">
            Click the link in the header to open in a new tab.
          </div>
        </div>
      ) : (
        <iframe
          src={url}
          title={title || 'Preview'}
          className={cn("absolute inset-0 w-full h-full border-0", className)}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
          style={{ background: 'white' }}
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false);
            setHasError(true);
          }}
        />
      )}
    </>
  );
}

