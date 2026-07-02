'use client';

import { useTranslations } from 'next-intl';

import { PublicShareLinkButton } from '@/components/projects/public-share-link-button';
import { Button } from '@/components/ui/button';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import type { CreateSessionPublicShareInput } from '@kortix/sdk/projects-client';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import {
  buildWebProxyUrl,
  isExternalUrl,
  isWebProxyUrl,
  normalizeExternalInput,
  parseLocalhostUrl,
  parseWebProxyUrl,
  proxyUrlToInternal,
  toInternalUrl,
} from '@/lib/utils/sandbox-url';
import { useTabStore } from '@/stores/tab-store';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface PreviewTabContentProps {
  tabId: string;
  projectId?: string;
  projectSessionId?: string;
}

const APP_PREVIEW_TITLE = 'App preview';

function normalizePreviewLabel(value: unknown): string {
  if (typeof value !== 'string') return APP_PREVIEW_TITLE;
  const trimmed = value.trim();
  if (!trimmed || /^localhost:\d+$/i.test(trimmed)) return APP_PREVIEW_TITLE;
  return trimmed;
}

function previewDisplayLabel(path: string, isEditing: boolean, addressValue: string) {
  if (isEditing) return addressValue;
  const cleanPath = path && path !== '/' ? path : '';
  return `${APP_PREVIEW_TITLE}${cleanPath}`;
}

/**
 * Preview tab content — renders a proxied sandbox URL in an iframe
 * with a browser-like toolbar: editable address bar, refresh, back/forward, open externally.
 *
 * The address bar shows the internal localhost:PORT URL and allows the user to type
 * any localhost:PORT address to navigate within the sandbox.
 */
export function PreviewTabContent({ tabId, projectId, projectSessionId }: PreviewTabContentProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
  const [addressValue, setAddressValue] = useState(
    originalUrl || (port ? `http://localhost:${port}/` : ''),
  );
  const [isAddressEditing, setIsAddressEditing] = useState(false);
  const addressInputRef = useRef<HTMLInputElement>(null);

  const isExternalBrowsing = useMemo(() => {
    return (
      !port &&
      !!originalUrl &&
      !originalUrl.startsWith('http://localhost') &&
      !originalUrl.startsWith('http://127.0.0.1')
    );
  }, [port, originalUrl]);

  const { subdomainOpts, proxyUrl, rewritePortPath } = useSandboxProxy();

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
  const navigateTo = useCallback(
    (url: string) => {
      const externalUrl = normalizeExternalInput(url);
      if (externalUrl && isExternalUrl(externalUrl)) {
        const newProxyUrl = buildWebProxyUrl(externalUrl, subdomainOpts);
        if (!newProxyUrl) return;

        let displayHost: string;
        try {
          displayHost = new URL(externalUrl).hostname;
        } catch {
          displayHost = externalUrl;
        }

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
        title: APP_PREVIEW_TITLE,
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
    },
    [subdomainOpts, rewritePortPath, tabId, updateTabMetadata, historyIndex],
  );

  /**
   * Handle address bar submission. This bar controls the sandbox's local
   * PORTS only — not arbitrary external sites — so we accept a bare port,
   * `:port`, `localhost:port`, `127.0.0.1:port`, or a full localhost URL
   * (each optionally followed by a path). Anything else (e.g. `google.com`)
   * is rejected inline rather than attempting to browse it.
   */
  const handleAddressSubmit = useCallback(
    (e: React.FormEvent) => {
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
    },
    [addressValue, navigateTo],
  );

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
        try {
          displayHost = new URL(targetUrl).hostname;
        } catch {
          displayHost = targetUrl;
        }
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

    const internal = proxyUrlToInternal(prevUrl);
    if (internal) {
      const parsed = parseLocalhostUrl(internal);
      if (parsed) {
        const internalUrl = toInternalUrl(parsed.port, parsed.path);
        updateTabMetadata({
          id: tabId,
          title: APP_PREVIEW_TITLE,
          type: 'preview',
          href: `/p/${parsed.port}`,
          metadata: {
            url: prevUrl,
            port: parsed.port,
            originalUrl: internalUrl,
            path: parsed.path,
          },
        });
        setAddressValue(internalUrl);
        setIsLoading(true);
        setHasError(false);
        setRefreshKey((k) => k + 1);
      }
    }
  }, [canGoBack, historyIndex, history, tabId, updateTabMetadata]);

  const handleForward = useCallback(() => {
    if (!canGoForward) return;
    const newIndex = historyIndex + 1;
    setHistoryIndex(newIndex);
    const nextUrl = history[newIndex];

    if (isWebProxyUrl(nextUrl)) {
      const targetUrl = parseWebProxyUrl(nextUrl);
      if (targetUrl) {
        let displayHost: string;
        try {
          displayHost = new URL(targetUrl).hostname;
        } catch {
          displayHost = targetUrl;
        }
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

    const internal = proxyUrlToInternal(nextUrl);
    if (internal) {
      const parsed = parseLocalhostUrl(internal);
      if (parsed) {
        const internalUrl = toInternalUrl(parsed.port, parsed.path);
        updateTabMetadata({
          id: tabId,
          title: APP_PREVIEW_TITLE,
          type: 'preview',
          href: `/p/${parsed.port}`,
          metadata: {
            url: nextUrl,
            port: parsed.port,
            originalUrl: internalUrl,
            path: parsed.path,
          },
        });
        setAddressValue(internalUrl);
        setIsLoading(true);
        setHasError(false);
        setRefreshKey((k) => k + 1);
      }
    }
  }, [canGoForward, historyIndex, history, tabId, updateTabMetadata]);

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
    if (isExternalBrowsing) return originalUrl;
    const parsed = parseLocalhostUrl(originalUrl || addressValue);
    return previewDisplayLabel(parsed?.path || '/', isAddressEditing, addressValue);
  }, [isAddressEditing, addressValue, port, isExternalBrowsing, originalUrl]);

  const shareInput = useMemo<CreateSessionPublicShareInput | null>(() => {
    if (isExternalBrowsing || port <= 0) return null;
    const parsed = parseLocalhostUrl(originalUrl || addressValue);
    const path = (tab?.metadata?.path as string) || parsed?.path || '/';
    return {
      mode: 'view',
      preview: {
        label: normalizePreviewLabel(tab?.title),
        url: originalUrl || toInternalUrl(port, path),
        port,
        path,
      },
    };
  }, [addressValue, isExternalBrowsing, originalUrl, port, tab?.metadata?.path, tab?.title]);

  // No "no preview URL available" empty state — when the tab doesn't exist
  // yet, the landing/no-previewUrl branch below renders the full browser
  // chrome (address bar + helper copy) so the user can navigate immediately.
  // Submitting from the address bar calls `updateTabMetadata` which creates
  // the tab on the fly.

  // Show a landing page when there's no URL yet (browser tab opened fresh)
  if (!previewUrl) {
    return (
      <div className="bg-background flex h-full flex-col">
        {/* Toolbar */}
        <div className="border-border/40 bg-background flex h-10 shrink-0 items-center gap-1 border-b px-2">
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
          <form onSubmit={handleAddressSubmit} className="flex flex-1 items-center">
            <div
              className={cn(
                'bg-foreground/[0.035] focus-within:bg-background focus-within:border-border/60 flex h-7 w-full items-center rounded-2xl border border-transparent px-2.5 text-xs tracking-tight transition-colors',
                addressError && 'border-red-500 focus-within:border-red-500',
              )}
            >
              <Globe
                className={cn(
                  'mr-2 h-3 w-3 shrink-0 opacity-50',
                  addressError && 'text-red-500 opacity-100',
                )}
              />
              <input
                ref={addressInputRef}
                type="text"
                value={addressValue}
                title={tI18nHardcoded.raw(
                  'autoComponentsTabsPreviewTabContentJsxAttrTitleEnterA2bdb9e26',
                )}
                onChange={(e) => {
                  setAddressValue(e.target.value);
                  if (addressError) setAddressError(false);
                }}
                onFocus={() => {
                  setIsAddressEditing(true);
                  // Select all on focus for easy replacement
                  setTimeout(() => addressInputRef.current?.select(), 0);
                }}
                onBlur={() => setIsAddressEditing(false)}
                placeholder={tI18nHardcoded.raw(
                  'autoComponentsTabsPreviewTabContentJsxAttrPlaceholderTypeA7d8290b9',
                )}
                className="text-foreground placeholder:text-muted-foreground flex-1 bg-transparent outline-none"
                autoFocus
              />
            </div>
          </form>
        </div>

        {/* Landing content */}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-muted-foreground flex max-w-md flex-col items-center gap-4 px-4 text-center">
            <Globe className="h-12 w-12 opacity-20" />
            <div>
              <p className="text-foreground text-sm font-medium">
                {tI18nHardcoded.raw(
                  'autoComponentsTabsPreviewTabContentJsxTextPreviewBrowser8136da05',
                )}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed">
                {tI18nHardcoded.raw('autoComponentsTabsPreviewTabContentJsxTextOpenAnAppda305669')}
                <span className="text-foreground/80 font-mono">3000</span>{' '}
                {tI18nHardcoded.raw('autoComponentsTabsPreviewTabContentJsxTextIfYouKnow6745fa88')}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full flex-col">
      {/* Toolbar */}
      <div className="border-border/40 bg-background flex h-10 shrink-0 items-center gap-1 border-b px-2">
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
        <form onSubmit={handleAddressSubmit} className="flex flex-1 items-center">
          <div
            className={cn(
              'bg-background flex h-7 w-full items-center rounded-2xl border px-3 text-xs',
              addressError && 'border-red-500 focus-within:border-red-500',
            )}
          >
            <Globe
              className={cn(
                'mr-2 h-3 w-3 shrink-0 opacity-50',
                addressError && 'text-red-500 opacity-100',
              )}
            />
            <input
              ref={addressInputRef}
              type="text"
              value={displayUrl}
              title={tI18nHardcoded.raw(
                'autoComponentsTabsPreviewTabContentJsxAttrTitleEnterA2bdb9e26',
              )}
              onChange={(e) => {
                setAddressValue(e.target.value);
                if (addressError) setAddressError(false);
              }}
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
              placeholder={tI18nHardcoded.raw(
                'autoComponentsTabsPreviewTabContentJsxAttrPlaceholderTypeA7d8290b9',
              )}
              className={cn(
                'text-foreground placeholder:text-muted-foreground flex-1 truncate bg-transparent outline-none',
                isAddressEditing && 'font-mono',
              )}
            />
            {port > 0 && !isAddressEditing && !isExternalBrowsing && (
              <span className="text-muted-foreground/70 ml-2 shrink-0 text-xs">Port {port}</span>
            )}
          </div>
        </form>

        {/* Open external */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleOpenExternal}
          title={tI18nHardcoded.raw(
            'autoComponentsTabsPreviewTabContentJsxAttrTitleOpenPrivate087e249c',
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
        <PublicShareLinkButton
          projectId={projectId}
          sessionId={projectSessionId}
          input={shareInput}
          tooltip={tI18nHardcoded.raw(
            'autoComponentsTabsPreviewTabContentJsxAttrTooltipCopyAe8e3844f',
          )}
          className="h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5"
        />
      </div>

      {/* Iframe container */}
      <div className="relative flex-1 overflow-hidden">
        {/* Loading overlay */}
        {isLoading && (
          <div className="bg-background/80 absolute inset-0 z-10 flex items-center justify-center">
            <div className="text-muted-foreground flex flex-col items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <p className="text-xs">
                {tHardcodedUi.raw('componentsTabsPreviewTabContent.line481JsxTextLoadingPreview')}
              </p>
            </div>
          </div>
        )}

        {/* Error state */}
        {hasError && (
          <div className="bg-background absolute inset-0 z-10 flex items-center justify-center">
            <div className="text-muted-foreground flex max-w-sm flex-col items-center gap-3 text-center">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <div>
                <p className="text-sm font-medium">
                  {tHardcodedUi.raw(
                    'componentsTabsPreviewTabContent.line492JsxTextFailedToLoadPreview',
                  )}
                </p>
                <p className="mt-1 text-xs">
                  {isExternalBrowsing
                    ? 'Could not reach the target website.'
                    : `The service on port ${port} may not be running yet.`}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
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
          className="h-full w-full border-0"
          sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
          onLoad={handleLoad}
          onError={handleError}
        />
      </div>
    </div>
  );
}
