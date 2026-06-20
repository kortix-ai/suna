'use client';

import { useTranslations } from 'next-intl';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Loader2, Monitor, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { SANDBOX_PORTS } from '@/lib/platform-client';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';

/**
 * DesktopTabContent — embeds the full Selkies desktop stream (port 6080) in an iframe.
 *
 * Shows the entire XFCE desktop running inside the sandbox container on DISPLAY :1,
 * including all windows, taskbar, file manager, and any applications. This gives the
 * user full desktop control — they can interact with any application, resize windows,
 * open terminals, etc.
 *
 * Resolution auto-adapts to iframe/browser size (set via Selkies env vars in Dockerfile).
 * SELKIES_USE_CSS_SCALING=false enables pixel perfect (HiDPI) mode with 225% UI scaling.
 */
export function DesktopTabContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { getServiceUrl } = useSandboxProxy();

  // Build the Selkies desktop URL for port 6080
  const rawDesktopUrl = useMemo(() => {
    const port = parseInt(SANDBOX_PORTS.DESKTOP, 10); // 6080
    return getServiceUrl(port) || '';
  }, [getServiceUrl]);

  const previewUrl = useAuthenticatedPreviewUrl(rawDesktopUrl);

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }, []);

  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleLoad = useCallback(() => {
    clearLoadTimeout();
    setIsLoading(false);
  }, [clearLoadTimeout]);

  const handleError = useCallback(() => {
    clearLoadTimeout();
    setIsLoading(false);
    setHasError(true);
  }, [clearLoadTimeout]);

  const handleOpenExternal = useCallback(() => {
    if (previewUrl) {
      window.open(previewUrl, '_blank', 'noopener,noreferrer');
    }
  }, [previewUrl]);

  // 8-second fallback for cross-origin iframe
  useEffect(() => {
    if (!isLoading) return;
    clearLoadTimeout();
    loadTimeoutRef.current = setTimeout(() => {
      setIsLoading(false);
    }, 8000);
    return clearLoadTimeout;
  }, [isLoading, refreshKey, clearLoadTimeout]);

  if (!previewUrl) {
    return (
      <div className="flex flex-col h-full bg-background">
        <div className="flex items-center justify-between h-9 px-3 border-b bg-muted/20 shrink-0">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Monitor className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Desktop</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <p className="text-xs">{tHardcodedUi.raw('componentsTabsDesktopTabContent.line99JsxTextConnectingToDesktop')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Minimal toolbar */}
      <div className="flex items-center justify-between h-9 px-3 border-b bg-muted/20 shrink-0">
        <div className="flex items-center gap-2">
          <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Desktop</span>
          {isLoading && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-xs">connecting</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRefresh} title="Refresh">
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleOpenExternal} title={tHardcodedUi.raw('componentsTabsDesktopTabContent.line124JsxAttrTitleOpenInNewTab')}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Iframe */}
      <div className="flex-1 relative overflow-hidden">
        {hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="flex flex-col items-center gap-3 text-muted-foreground max-w-sm text-center">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <div>
                <p className="text-sm font-medium">{tHardcodedUi.raw('componentsTabsDesktopTabContent.line137JsxTextDesktopUnavailable')}</p>
                <p className="text-xs mt-1">{tHardcodedUi.raw('componentsTabsDesktopTabContent.line139JsxTextTheDesktopStreamPort6080IsNotReachable')}</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          </div>
        )}

        <iframe
          key={refreshKey}
          ref={iframeRef}
          src={previewUrl}
          title={tHardcodedUi.raw('componentsTabsDesktopTabContent.line154JsxAttrTitleSandboxDesktop')}
          className="w-full h-full border-0"
          sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
          onLoad={handleLoad}
          onError={handleError}
        />
      </div>
    </div>
  );
}
