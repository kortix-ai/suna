'use client';

import { useTranslations } from 'next-intl';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RefreshCw,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useTabStore } from '@/stores/tab-store';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import {
  parseLocalhostUrl,
  toInternalUrl,
  proxyUrlToInternal,
  buildWebProxyUrl,
  parseWebProxyUrl,
  isWebProxyUrl,
  isExternalUrl,
  normalizeExternalInput,
} from '@/lib/utils/sandbox-url';

interface PreviewTabContentProps {
  tabId: string;
}

/**
 * Preview tab content — renders a proxied sandbox URL in an iframe
 * with a browser-like toolbar: editable address bar, refresh, back/forward, open externally.
 *
 * The address bar shows the internal localhost:PORT URL and allows the user to type
 * any localhost:PORT address to navigate within the sandbox.
 */
export function PreviewTabContent({ tabId }: PreviewTabContentProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tab = useTabStore((s) => s.tabs[tabId]);
  const updateTabMetadata = useTabStore((s) => s.openTab);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Set when the address bar gets something that isn't a sandbox port, so we
  // can flag it inline instead of attempting to browse it.
  const [addressError, setAddressError] = useState(false);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extract metadata from tab
  const rawPreviewUrl = (tab?.metadata?.url as string) || '';
  const port = (tab?.metadata?.port as number) || 0;
  const originalUrl = (tab?.metadata?.originalUrl as string) || '';

  // Address bar state — shows the internal localhost URL
  const [addressValue, setAddressValue] = useState(originalUrl || (port ? `http://localhost:${port}/` : ''));
  const [isAddressEditing, setIsAddressEditing] = useState(false);
  const addressInputRef = useRef<HTMLInputElement>(null);

  const isExternalBrowsing = useMemo(() => {
    return !port && !!originalUrl && !originalUrl.startsWith('http://localhost') && !originalUrl.startsWith('http://127.0.0.1');
  }, [port, originalUrl]);

  const { activeServer, subdomainOpts, proxyUrl, rewritePortPath } = useSandboxProxy();

  const proxiedPreviewUrl = useMemo(
    () => proxyUrl(rawPreviewUrl) ?? rawPreviewUrl,
    [proxyUrl, rawPreviewUrl],
  );

  // Navigation history
  const [history, setHistory] = useState<string[]>([proxiedPreviewUrl].filter(Boolean));
  const [historyIndex, setHistoryIndex] = useState(0);

  // Inject auth token for cloud preview proxy URLs.
  // Returns null while auth is in progress — the existing `if (!previewUrl)` guard
  // below will show a landing state until the token is ready.
  const previewUrl = useAuthenticatedPreviewUrl(proxiedPreviewUrl);

  useEffect(() => {
    if (!proxiedPreviewUrl) return;
    setHistory((prev) => (prev.length === 0 ? [proxiedPreviewUrl] : prev));
  }, [proxiedPreviewUrl]);

  // Sync address bar when tab metadata changes externally
  useEffect(() => {
    if (!isAddressEditing) {
      if (isExternalBrowsing) {
        setAddressValue(originalUrl);
      } else {
        setAddressValue(originalUrl || (port ? `http://localhost:${port}/` : ''));
      }
    }
  }, [originalUrl, port, isAddressEditing, isExternalBrowsing]);

  /** Clear any pending load timeout. */
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

  /** Navigate to a new URL within the sandbox. */
  const navigateTo = useCallback((url: string) => {
    const externalUrl = normalizeExternalInput(url);
    if (externalUrl && isExternalUrl(externalUrl)) {
      const newProxyUrl = buildWebProxyUrl(externalUrl, subdomainOpts);
      if (!newProxyUrl) return;

      let displayHost: string;
      try { displayHost = new URL(externalUrl).hostname; } catch { displayHost = externalUrl; }

      updateTabMetadata({
        id: tabId,
        title: displayHost,
        type: 'preview',
        href: `/p/web`,
        metadata: { url: newProxyUrl, port: 0, originalUrl: externalUrl, path: '/' },
      });

      setAddressValue(externalUrl);

      setHistory((prev) => {
        const trimmed = prev.slice(0, historyIndex + 1);
        return [...trimmed, newProxyUrl];
      });
      setHistoryIndex((prev) => prev + 1);

      setIsLoading(true);
      setHasError(false);
      setRefreshKey((k) => k + 1);
      return;
    }

    const parsed = parseLocalhostUrl(url);
    if (!parsed) return;

    const { port: newPort, path: newPath } = parsed;
    const newProxyUrl = rewritePortPath(newPort, newPath);
    const newInternalUrl = toInternalUrl(newPort, newPath);

    updateTabMetadata({
      id: tabId,
      title: `localhost:${newPort}`,
      type: 'preview',
      href: `/p/${newPort}`,
      metadata: { url: newProxyUrl, port: newPort, originalUrl: newInternalUrl, path: newPath },
    });

    setAddressValue(newInternalUrl);

    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, newProxyUrl];
    });
    setHistoryIndex((prev) => prev + 1);

    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, [subdomainOpts, rewritePortPath, tabId, updateTabMetadata, historyIndex]);

  /**
   * Handle address bar submission. This bar controls the sandbox's local
   * PORTS only — not arbitrary external sites — so we accept a bare port,
   * `:port`, `localhost:port`, `127.0.0.1:port`, or a full localhost URL
   * (each optionally followed by a path). Anything else (e.g. `google.com`)
   * is rejected inline rather than attempting to browse it.
   */
  const handleAddressSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();

    let url = addressValue.trim();
    if (!url) return;

    if (/^\d{1,5}(?:[/?#]|$)/.test(url)) {
      url = `http://localhost:${url}`;
    } else if (/^:\d{1,5}/.test(url)) {
      url = `http://localhost${url}`;
    } else if (/^(?:localhost|127\.0\.0\.1):\d+/i.test(url)) {
      url = `http://${url}`;
    }

    const parsed = parseLocalhostUrl(url);
    if (!parsed) {
      setAddressError(true);
      return;
    }

    setAddressError(false);
    setIsAddressEditing(false);
    navigateTo(toInternalUrl(parsed.port, parsed.path));
  }, [addressValue, navigateTo]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const handleBack = useCallback(() => {
    if (!canGoBack) return;
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    const prevUrl = history[newIndex];

    if (isWebProxyUrl(prevUrl)) {
      const targetUrl = parseWebProxyUrl(prevUrl);
      if (targetUrl) {
        let displayHost: string;
        try { displayHost = new URL(targetUrl).hostname; } catch { displayHost = targetUrl; }
        updateTabMetadata({
          id: tabId,
          title: displayHost,
          type: 'preview',
          href: `/p/web`,
          metadata: { url: prevUrl, port: 0, originalUrl: targetUrl, path: '/' },
        });
        setAddressValue(targetUrl);
        setIsLoading(true);
        setHasError(false);
        setRefreshKey((k) => k + 1);
        return;
      }
    }

    const internal = proxyUrlToInternal(prevUrl, activeServer?.mappedPorts);
    if (internal) {
      const parsed = parseLocalhostUrl(internal);
      if (parsed) {
        const internalUrl = toInternalUrl(parsed.port, parsed.path);
        updateTabMetadata({
          id: tabId,
          title: `localhost:${parsed.port}`,
          type: 'preview',
          href: `/p/${parsed.port}`,
          metadata: { url: prevUrl, port: parsed.port, originalUrl: internalUrl, path: parsed.path },
        });
        setAddressValue(internalUrl);
        setIsLoading(true);
        setHasError(false);
        setRefreshKey((k) => k + 1);
      }
    }
  }, [canGoBack, historyIndex, history, tabId, updateTabMetadata, activeServer?.mappedPorts]);

  const handleForward = useCallback(() => {
    if (!canGoForward) return;
    const newIndex = historyIndex + 1;
    setHistoryIndex(newIndex);
    const nextUrl = history[newIndex];

    if (isWebProxyUrl(nextUrl)) {
      const targetUrl = parseWebProxyUrl(nextUrl);
      if (targetUrl) {
        let displayHost: string;
        try { displayHost = new URL(targetUrl).hostname; } catch { displayHost = targetUrl; }
        updateTabMetadata({
          id: tabId,
          title: displayHost,
          type: 'preview',
          href: `/p/web`,
          metadata: { url: nextUrl, port: 0, originalUrl: targetUrl, path: '/' },
        });
        setAddressValue(targetUrl);
        setIsLoading(true);
        setHasError(false);
        setRefreshKey((k) => k + 1);
        return;
      }
    }

    const internal = proxyUrlToInternal(nextUrl, activeServer?.mappedPorts);
    if (internal) {
      const parsed = parseLocalhostUrl(internal);
      if (parsed) {
        const internalUrl = toInternalUrl(parsed.port, parsed.path);
        updateTabMetadata({
          id: tabId,
          title: `localhost:${parsed.port}`,
          type: 'preview',
          href: `/p/${parsed.port}`,
          metadata: { url: nextUrl, port: parsed.port, originalUrl: internalUrl, path: parsed.path },
        });
        setAddressValue(internalUrl);
        setIsLoading(true);
        setHasError(false);
        setRefreshKey((k) => k + 1);
      }
    }
  }, [canGoForward, historyIndex, history, tabId, updateTabMetadata, activeServer?.mappedPorts]);

  // Fallback: if onLoad doesn't fire within 5s, dismiss the loading state.
  // Cross-origin iframes frequently fail to fire onLoad events.
  useEffect(() => {
    if (!isLoading) return;
    clearLoadTimeout();
    loadTimeoutRef.current = setTimeout(() => {
      setIsLoading(false);
    }, 5000);
    return clearLoadTimeout;
  }, [isLoading, refreshKey, clearLoadTimeout]);

  // Display URL (the internal localhost URL for clean look)
  const displayUrl = useMemo(() => {
    if (isAddressEditing) return addressValue;
    if (isExternalBrowsing) return originalUrl;
    return addressValue || (port ? `localhost:${port}` : rawPreviewUrl);
  }, [isAddressEditing, addressValue, port, rawPreviewUrl, isExternalBrowsing, originalUrl]);

  // No "no preview URL available" empty state — when the tab doesn't exist
  // yet, the landing/no-previewUrl branch below renders the full browser
  // chrome (address bar + helper copy) so the user can navigate immediately.
  // Submitting from the address bar calls `updateTabMetadata` which creates
  // the tab on the fly.

  // Show a landing page when there's no URL yet (browser tab opened fresh)
  if (!previewUrl) {
    return (
      <div className="flex flex-col h-full bg-background">
        {/* Toolbar */}
        <div className="flex items-center gap-1 h-10 px-2 border-b border-border/40 bg-background shrink-0">
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>

          {/* Address bar */}
          <form onSubmit={handleAddressSubmit} className="flex-1 flex items-center">
            <div
              className={cn(
                'w-full flex items-center h-7 px-2.5 bg-foreground/[0.035] border border-transparent rounded-2xl text-xs tracking-tight focus-within:bg-background focus-within:border-border/60 transition-colors',
                addressError && 'border-red-500 focus-within:border-red-500',
              )}
            >
              <Globe className={cn('h-3 w-3 mr-2 shrink-0 opacity-50', addressError && 'text-red-500 opacity-100')} />
              <input
                ref={addressInputRef}
                type="text"
                value={addressValue}
                title="Enter a sandbox port, e.g. 3000"
                onChange={(e) => { setAddressValue(e.target.value); if (addressError) setAddressError(false); }}
                onFocus={() => {
                  setIsAddressEditing(true);
                  // Select all on focus for easy replacement
                  setTimeout(() => addressInputRef.current?.select(), 0);
                }}
                onBlur={() => setIsAddressEditing(false)}
                placeholder={tHardcodedUi.raw('componentsTabsPreviewTabContent.line357JsxAttrPlaceholderTypeAUrlOrLocalhostPort')}
                className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
          </form>
        </div>

        {/* Landing content */}
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-muted-foreground max-w-md text-center px-4">
            <Globe className="h-12 w-12 opacity-20" />
            <div>
              <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsTabsPreviewTabContent.line370JsxTextInternalBrowser')}</p>
              <p className="text-xs mt-1.5 leading-relaxed">{tHardcodedUi.raw('componentsTabsPreviewTabContent.line372JsxTextBrowseAnyWebsiteOrServiceRunningInsideThe')}<span className="font-mono text-foreground/80">google.com</span> or <span className="font-mono text-foreground/80">localhost:3000</span>{tHardcodedUi.raw('componentsTabsPreviewTabContent.line373JsxTextInTheAddressBarAbove')}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-1 h-10 px-2 border-b border-border/40 bg-background shrink-0">
        {/* Back */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleBack}
          disabled={!canGoBack}
          title="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>

        {/* Forward */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleForward}
          disabled={!canGoForward}
          title="Forward"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>

        {/* Refresh */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleRefresh}
          title="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </Button>

        {/* Address bar — editable */}
        <form onSubmit={handleAddressSubmit} className="flex-1 flex items-center">
          <div
            className={cn(
              'w-full flex items-center h-7 px-3 bg-background border rounded-2xl text-xs font-mono',
              addressError && 'border-red-500 focus-within:border-red-500',
            )}
          >
            <Globe className={cn('h-3 w-3 mr-2 shrink-0 opacity-50', addressError && 'text-red-500 opacity-100')} />
            <input
              ref={addressInputRef}
              type="text"
              value={displayUrl}
              title="Enter a sandbox port, e.g. 3000"
              onChange={(e) => { setAddressValue(e.target.value); if (addressError) setAddressError(false); }}
              onFocus={() => {
                setIsAddressEditing(true);
                if (isExternalBrowsing) {
                  setAddressValue(originalUrl);
                } else {
                  setAddressValue(originalUrl || (port ? `http://localhost:${port}/` : ''));
                }
                setTimeout(() => addressInputRef.current?.select(), 0);
              }}
              onBlur={() => setIsAddressEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setIsAddressEditing(false);
                  if (isExternalBrowsing) {
                    setAddressValue(originalUrl);
                  } else {
                    setAddressValue(originalUrl || (port ? `http://localhost:${port}/` : ''));
                  }
                  addressInputRef.current?.blur();
                }
              }}
              placeholder={tHardcodedUi.raw('componentsTabsPreviewTabContent.line451JsxAttrPlaceholderTypeAUrlOrLocalhostPort')}
              className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground truncate"
            />
            {port > 0 && !isAddressEditing && !isExternalBrowsing && (
              <span className="ml-2 shrink-0 text-xs text-muted-foreground/70">
                :{port}
              </span>
            )}
          </div>
        </form>

        {/* Open external */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleOpenExternal}
          title={tHardcodedUi.raw('componentsTabsPreviewTabContent.line468JsxAttrTitleOpenInBrowser')}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Iframe container */}
      <div className="flex-1 relative overflow-hidden">
        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <p className="text-xs">{tHardcodedUi.raw('componentsTabsPreviewTabContent.line481JsxTextLoadingPreview')}</p>
            </div>
          </div>
        )}

        {/* Error state */}
        {hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="flex flex-col items-center gap-3 text-muted-foreground max-w-sm text-center">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <div>
                <p className="text-sm font-medium">{tHardcodedUi.raw('componentsTabsPreviewTabContent.line492JsxTextFailedToLoadPreview')}</p>
                <p className="text-xs mt-1">
                  {isExternalBrowsing
                    ? 'Could not reach the target website.'
                    : `The service on port ${port} may not be running yet.`}
                </p>
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
          title={isExternalBrowsing ? `Browse: ${originalUrl}` : `Preview :${port}`}
          className="w-full h-full border-0"
          sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
          onLoad={handleLoad}
          onError={handleError}
        />
      </div>
    </div>
  );
}
