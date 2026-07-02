'use client';

import { useTranslations } from 'next-intl';

import React from 'react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { getIframeSandbox } from '@/lib/security/iframe-sandbox';

interface IframePreviewProps {
  url: string;
  title?: string;
  className?: string;
  sandbox?: string;
}

export function IframePreview({
  url,
  title,
  className,
  sandbox = getIframeSandbox(),
}: IframePreviewProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isLoading, setIsLoading] = React.useState(true);
  const [hasError, setHasError] = React.useState(false);

  return (
    <>
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
          <KortixLoader size="medium" />
        </div>
      )}

      {/* Error state */}
      {hasError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-muted/30">
          <div className="text-muted-foreground font-medium mb-1">{tHardcodedUi.raw('componentsThreadIframePreview.line36JsxTextUnableToLoadPreview')}</div>
          <div className="text-muted-foreground text-sm text-center mb-4">{tHardcodedUi.raw('componentsThreadIframePreview.line38JsxTextClickTheLinkInTheHeaderToOpen')}</div>
        </div>
      ) : (
        <iframe
          src={url}
          title={title || 'Preview'}
          className={cn("absolute inset-0 w-full h-full border-0", className)}
          sandbox={sandbox}
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
