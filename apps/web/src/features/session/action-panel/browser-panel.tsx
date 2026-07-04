'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
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
import { recentDisplayLabel, useBrowserRecentsStore } from '@/stores/browser-recents-store';
import { useTabStore } from '@/stores/tab-store';
import {
  createSessionPublicShare,
  type CreateSessionPublicShareInput,
} from '@kortix/sdk/projects-client';
import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Globe,
  Link2,
  MoreHorizontal,
  RefreshCw,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GrRefresh } from 'react-icons/gr';
import { TbExternalLink } from 'react-icons/tb';

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

/** Split a URL so the hostname can be rendered brighter than the rest. */
function splitUrlForDisplay(url: string): { prefix: string; host: string; rest: string } | null {
  try {
    const host = new URL(url).host;
    const idx = url.indexOf(host);
    if (!host || idx === -1) return null;
    return { prefix: url.slice(0, idx), host, rest: url.slice(idx + host.length) };
  } catch {
    return null;
  }
}

/**
 * Preview tab content — renders a proxied sandbox URL in an iframe
 * with a browser-like toolbar: editable address bar, refresh, back/forward, open externally.
 *
 * The address bar shows the internal localhost:PORT URL and allows the user to type
 * any localhost:PORT address to navigate within the sandbox. Visited URLs are
 * recorded and offered back as "Recents" on the empty landing state.
 */
export function BrowserPanel({ tabId, projectId, projectSessionId }: PreviewTabContentProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tab = useTabStore((s) => s.tabs[tabId]);
  const updateTabMetadata = useTabStore((s) => s.openTab);
  const recents = useBrowserRecentsStore((s) => s.recents);
  const addRecent = useBrowserRecentsStore((s) => s.addRecent);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Set when the address bar gets something that isn't a sandbox port, so we
  // can flag it inline instead of attempting to browse it.
  const [addressError, setAddressError] = useState(false);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Recents come from a persisted store — render them only after mount so the
  // server and first client render agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
  // Returns null while auth is in progress — the landing state below renders
  // until the token is ready.
  const previewUrl = useAuthenticatedPreviewUrl(proxiedPreviewUrl);

  useEffect(() => {
    if (!proxiedPreviewUrl) return;
    setHistory((prev) => (prev.length === 0 ? [proxiedPreviewUrl] : prev));
  }, [proxiedPreviewUrl]);

  // Every URL the panel actually shows becomes a "Recent" — including
  // navigations initiated by the agent (they arrive as metadata changes).
  useEffect(() => {
    if (!originalUrl || !previewUrl) return;
    addRecent(originalUrl);
  }, [originalUrl, previewUrl, addRecent]);

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

  // At rest the bar always shows the full URL; the overlay below re-renders it
  // with the hostname highlighted (an input can't mix text colors).
  const fullUrl = originalUrl || (port ? `http://localhost:${port}/` : '');
  const urlParts = useMemo(
    () => (isAddressEditing || addressError || !previewUrl ? null : splitUrlForDisplay(fullUrl)),
    [isAddressEditing, addressError, previewUrl, fullUrl],
  );

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

  const resetAddressToCurrent = useCallback(() => {
    if (isExternalBrowsing) {
      setAddressValue(originalUrl);
    } else {
      setAddressValue(originalUrl || (port ? `http://localhost:${port}/` : ''));
    }
  }, [isExternalBrowsing, originalUrl, port]);

  const hasPreview = !!previewUrl;
  const showRecents = mounted && recents.length > 0;

  // Copy-public-link action, surfaced from the "⋯" overflow menu. Same flow
  // as PublicShareLinkButton: create the share, copy the URL, toast the result.
  const shareLink = useMutation({
    mutationFn: async () => {
      if (!projectId || !projectSessionId || !shareInput) {
        throw new Error('Nothing is selected to share');
      }
      const result = await createSessionPublicShare(projectId, projectSessionId, shareInput);
      if (!result.share.public_path) {
        throw new Error('Share link was not returned');
      }
      const publicUrl = `${window.location.origin}${result.share.public_path}`;
      await navigator.clipboard.writeText(publicUrl);
      return publicUrl;
    },
    onSuccess: () => {
      successToast('Public link copied');
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : 'Could not create public link');
    },
  });
  const canShare = hasPreview && !!projectId && !!projectSessionId && !!shareInput;

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="border-border bg-background flex shrink-0 items-center gap-0.5 border-b p-2">
        <Hint label="Back" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            disabled={!hasPreview || !canGoBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
        </Hint>

        <Hint label="Forward" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleForward}
            disabled={!hasPreview || !canGoForward}
          >
            <ArrowRight className="size-4" />
          </Button>
        </Hint>

        <Hint label="Refresh" side="bottom">
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={!hasPreview}>
            <GrRefresh className={cn('size-4', isLoading && 'animate-spinner-spin')} />
          </Button>
        </Hint>

        <form onSubmit={handleAddressSubmit} className="flex min-w-0 flex-1 items-center px-1">
          <div
            className={cn(
              'group/address hover:bg-input focus-within:bg-input focus-within:border-border relative flex h-7 w-full items-center rounded-sm border border-transparent bg-transparent px-3.5 text-xs tracking-tight transition-colors',
              addressError &&
                'border-kortix-red/60 focus-within:border-kortix-red/60 animate-shake',
            )}
          >
            <Input
              ref={addressInputRef}
              type="text"
              size="xs"
              value={urlParts ? fullUrl : addressValue}
              title={tHardcodedUi.raw(
                'autoComponentsTabsPreviewTabContentJsxAttrTitleEnterA2bdb9e26',
              )}
              onChange={(e) => {
                setAddressValue(e.target.value);
                if (addressError) setAddressError(false);
              }}
              onFocus={() => {
                setIsAddressEditing(true);
                if (hasPreview) resetAddressToCurrent();
                setTimeout(() => addressInputRef.current?.select(), 0);
              }}
              onBlur={() => setIsAddressEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setIsAddressEditing(false);
                  setAddressError(false);
                  if (hasPreview) resetAddressToCurrent();
                  addressInputRef.current?.blur();
                }
              }}
              placeholder={tHardcodedUi.raw(
                'autoComponentsTabsPreviewTabContentJsxAttrPlaceholderTypeA7d8290b9',
              )}
              className={cn(
                'h-full min-w-0 flex-1 truncate rounded-none border-none bg-transparent px-0 font-medium focus:border-none',
                // isAddressEditing && !!addressValue && 'font-mono',
                urlParts && 'text-transparent',
              )}
              autoFocus={!rawPreviewUrl}
            />
            {urlParts && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-3.5 left-3.5 flex items-center overflow-hidden whitespace-nowrap"
              >
                <span className="text-muted-foreground group-hover/address:text-foreground truncate transition-colors">
                  {urlParts.prefix}
                  <span className="text-foreground">{urlParts.host}</span>
                  {urlParts.rest}
                </span>
              </span>
            )}
            {addressError && (
              <span className="text-kortix-red ml-2 shrink-0 text-xs">Sandbox ports only</span>
            )}
          </div>
        </form>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" disabled={!hasPreview} aria-label="More options">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-32">
            <DropdownMenuItem onClick={handleOpenExternal}>
              <TbExternalLink />
              {tHardcodedUi.raw(
                'autoComponentsTabsPreviewTabContentJsxAttrTitleOpenPrivate087e249c',
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => shareLink.mutate()}
              disabled={!canShare || shareLink.isPending}
            >
              <Link2 />
              Copy public link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {hasPreview ? (
        /* Iframe container */
        <div className="relative flex-1 overflow-hidden">
          {/* Loading overlay */}
          {isLoading && (
            <div className="bg-background/80 absolute inset-0 z-10 flex items-center justify-center">
              <div className="text-muted-foreground flex flex-col items-center gap-2">
                <Loading className="size-4" />
                <p className="text-xs">
                  {tHardcodedUi.raw('componentsTabsPreviewTabContent.line481JsxTextLoadingPreview')}
                </p>
              </div>
            </div>
          )}

          {/* Error state */}
          {hasError && (
            <div className="bg-background absolute inset-0 z-10 flex items-center justify-center">
              <div className="flex max-w-sm flex-col items-center gap-4 text-center">
                <span className="bg-kortix-orange/15 flex size-9 items-center justify-center rounded-sm">
                  <AlertTriangle className="text-kortix-orange size-5" />
                </span>
                <div>
                  <p className="text-sm font-medium">
                    {tHardcodedUi.raw(
                      'componentsTabsPreviewTabContent.line492JsxTextFailedToLoadPreview',
                    )}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {isExternalBrowsing
                      ? 'Could not reach the target website.'
                      : `The service on port ${port} may not be running yet.`}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRefresh}>
                  <RefreshCw className="size-3.5 shrink-0" />
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
      ) : (
        /* Landing — recent URLs when we have them, helper copy otherwise */
        <div className="flex-1 overflow-y-auto">
          {showRecents ? (
            <div className="mx-auto w-full max-w-md px-6 py-12">
              <section className="space-y-3">
                <h3 className="text-muted-foreground px-2 text-sm">Recents</h3>
                <ul className="space-y-1">
                  {recents.map((recent, i) => (
                    <li
                      key={recent.url}
                      className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both"
                      style={{ animationDelay: `${i * 40}ms` }}
                    >
                      <button
                        type="button"
                        onClick={() => navigateTo(recent.url)}
                        className="hover:bg-foreground/5 flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors active:scale-[0.99]"
                      >
                        {isExternalUrl(recent.url) ? (
                          <FaviconAvatar value={recent.url} size="xs" className="shrink-0" />
                        ) : (
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <Globe className="text-muted-foreground/60 size-4" />
                          </span>
                        )}
                        <span className="text-foreground/90 min-w-0 flex-1 truncate text-sm">
                          {recentDisplayLabel(recent.url)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-muted-foreground flex max-w-sm flex-col items-center gap-4 px-4 text-center">
                <Globe className="size-12 opacity-20" />
                <div>
                  <p className="text-foreground text-sm font-medium">
                    {tHardcodedUi.raw(
                      'autoComponentsTabsPreviewTabContentJsxTextPreviewBrowser8136da05',
                    )}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-balance">
                    {tHardcodedUi.raw(
                      'autoComponentsTabsPreviewTabContentJsxTextOpenAnAppda305669',
                    )}{' '}
                    <span className="text-foreground/80 font-mono">3000</span>{' '}
                    {tHardcodedUi.raw(
                      'autoComponentsTabsPreviewTabContentJsxTextIfYouKnow6745fa88',
                    )}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
