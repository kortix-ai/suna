'use client';

import { SessionSharesModal } from '@/components/projects/session-shares-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { isKortixAppUrl } from '@/features/session/kortix-app-url';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { PublicShareLinkConfirm } from '@/components/projects/public-share-link-confirm';
import { usePublicShareLink } from '@/hooks/use-public-share-link';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { useSessionPublicShares } from '@/hooks/use-session-public-shares';
import { useTranslations } from '@/i18n/use-translations';
import { framePolicy } from '@/features/file-viewer/preview-policy';
import { focusWithoutScroll } from '@/lib/utils/focus-without-scroll';
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
import { useBrowserRecentsStore } from '@/stores/browser-recents-store';
import { useTabStore } from '@/stores/tab-store';
import type { CreateSessionPublicShareInput } from '@kortix/sdk';import {
  WarningIcon as AlertTriangle,
  ArrowSquareOutIcon,
  GlobeIcon as Globe,
  LinkSimpleIcon as Link2,
  DotsThreeIcon as MoreHorizontal,
  ArrowClockwiseIcon as RefreshCw,
  GearSixIcon as Settings2,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PreviewLoadingOverlay, PreviewRecentsLanding, SandboxAddressBar } from './shared/sandbox-browser-chrome';

interface PreviewTabContentProps {
  tabId: string;
  projectId?: string;
  projectSessionId?: string;
}

function normalizePreviewLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || /^localhost:\d+$/i.test(trimmed)) return fallback;
  return trimmed;
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appPreviewTitle = tI18nComplete.raw('text6026c1d8c92e');
  const tab = useTabStore((s) => s.tabs[tabId]);
  const updateTabMetadata = useTabStore((s) => s.openTab);
  const recents = useBrowserRecentsStore((s) => s.recents);
  const addRecent = useBrowserRecentsStore((s) => s.addRecent);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Recents come from a persisted store — render them only after mount so the
  // server and first client render agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Extract metadata from tab
  const rawPreviewUrl = (tab?.metadata?.url as string) || '';
  const port = (tab?.metadata?.port as number) || 0;
  const originalUrl = (tab?.metadata?.originalUrl as string) || '';

  const addressInputRef = useRef<HTMLInputElement>(null);

  // Empty landing gets the cursor, like `autoFocus` did — but through
  // `focusWithoutScroll`, because React's `autoFocus` is a bare focus() at
  // mount, and mount can happen while the panel is mid enter-animation: the
  // reveal scroll shoves a permanent sideways offset onto the panel's
  // overflow-hidden ancestors. Mount-only on purpose (`autoFocus` semantics —
  // a later navigation clearing the URL must not steal the cursor).
  const autoFocusAddressRef = useRef(!rawPreviewUrl);
  useEffect(() => {
    if (autoFocusAddressRef.current) focusWithoutScroll(addressInputRef.current);
  }, []);

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
  const [history, setHistory] = useState<string[]>(() => [proxiedPreviewUrl].filter(Boolean));
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
  /** Push a URL onto the history stack, truncating any forward entries. */
  const pushHistory = useCallback(
    (proxyUrl: string) => {
      setHistory((prev) => {
        const trimmed = prev.slice(0, historyIndex + 1);
        return [...trimmed, proxyUrl];
      });
      setHistoryIndex((prev) => prev + 1);
    },
    [historyIndex],
  );

  const navigateTo = useCallback(
    (url: string) => {
      const externalUrl = normalizeExternalInput(url);
      if (externalUrl && isExternalUrl(externalUrl)) {
        const newProxyUrl = isKortixAppUrl(externalUrl)
          ? externalUrl
          : buildWebProxyUrl(externalUrl, subdomainOpts);
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

        pushHistory(newProxyUrl);
        handleRefresh();
        return;
      }

      const parsed = parseLocalhostUrl(url);
      if (!parsed) return;

      const { port: newPort, path: newPath } = parsed;
      const newProxyUrl = rewritePortPath(newPort, newPath);
      const newInternalUrl = toInternalUrl(newPort, newPath);

      updateTabMetadata({
        id: tabId,
        title: appPreviewTitle,
        type: 'preview',
        href: `/p/${newPort}`,
        metadata: { url: newProxyUrl, port: newPort, originalUrl: newInternalUrl, path: newPath },
      });

      pushHistory(newProxyUrl);
      handleRefresh();
    },
    [subdomainOpts, rewritePortPath, tabId, updateTabMetadata, pushHistory, handleRefresh],
  );

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  /** Walk the history stack in either direction; the two directions were two
   *  byte-identical callbacks except for the sign. */
  const goHistory = useCallback(
    (delta: -1 | 1) => {
      if (delta < 0 ? !canGoBack : !canGoForward) return;
      const newIndex = historyIndex + delta;
      setHistoryIndex(newIndex);
      const url = history[newIndex];

      if (isWebProxyUrl(url)) {
        const targetUrl = parseWebProxyUrl(url);
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
            metadata: { url, port: 0, originalUrl: targetUrl, path: '/' },
          });
          handleRefresh();
          return;
        }
      }

      const internal = proxyUrlToInternal(url);
      if (internal) {
        const parsed = parseLocalhostUrl(internal);
        if (parsed) {
          const internalUrl = toInternalUrl(parsed.port, parsed.path);
          updateTabMetadata({
            id: tabId,
            title: appPreviewTitle,
            type: 'preview',
            href: `/p/${parsed.port}`,
            metadata: { url, port: parsed.port, originalUrl: internalUrl, path: parsed.path },
          });
          handleRefresh();
        }
      }
    },
    [canGoBack, canGoForward, historyIndex, history, tabId, updateTabMetadata, handleRefresh],
  );

  const handleBack = useCallback(() => goHistory(-1), [goHistory]);
  const handleForward = useCallback(() => goHistory(1), [goHistory]);

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

  // At rest the bar always shows the full URL; the overlay in
  // `SandboxAddressBar` re-renders it with the hostname highlighted (an input
  // can't mix text colors).
  const fullUrl = originalUrl || (port ? `http://localhost:${port}/` : '');

  const shareInput = useMemo<CreateSessionPublicShareInput | null>(() => {
    if (isExternalBrowsing || port <= 0) return null;
    const parsed = parseLocalhostUrl(originalUrl || fullUrl);
    const path = (tab?.metadata?.path as string) || parsed?.path || '/';
    return {
      mode: 'view',
      preview: {
        label: normalizePreviewLabel(tab?.title, appPreviewTitle),
        url: originalUrl || toInternalUrl(port, path),
        port,
        path,
      },
    };
  }, [fullUrl, isExternalBrowsing, originalUrl, port, tab?.metadata?.path, tab?.title]);

  const hasPreview = !!previewUrl;
  const showRecents = mounted && recents.length > 0;

  // Copy-public-link action, surfaced from the "⋯" overflow menu.
  const shareLink = usePublicShareLink({
    projectId,
    sessionId: projectSessionId,
    input: shareInput,
  });
  const canShare = hasPreview && shareLink.canShare;

  const [sharesOpen, setSharesOpen] = useState(false);
  const { liveShares } = useSessionPublicShares(projectId, projectSessionId);

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="border-border bg-background flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
        <SandboxAddressBar
          displayValue={fullUrl}
          hasPreview={hasPreview}
          isLoading={isLoading}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleRefresh}
          onNavigate={navigateTo}
          placeholder={tHardcodedUi.raw(
            'autoComponentsTabsPreviewTabContentJsxAttrPlaceholderTypeA7d8290b9',
          )}
          ariaLabel={tHardcodedUi.raw(
            'autoComponentsTabsPreviewTabContentJsxAttrTitleEnterA2bdb9e26',
          )}
          inputRef={addressInputRef}
          resetOnEscape={hasPreview}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={!hasPreview}
              aria-label={tHardcodedUi.raw('i18nComplete.textbc79cdffbaa8')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-32">
            <DropdownMenuItem onClick={handleOpenExternal}>
              <ArrowSquareOutIcon />
              {tHardcodedUi.raw(
                'autoComponentsTabsPreviewTabContentJsxAttrTitleOpenPrivate087e249c',
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={shareLink.copyLink}
              disabled={!canShare || shareLink.isPending}
            >
              <Link2 />
              {tHardcodedUi.raw('i18nComplete.text8a29ed34cf47')}
            </DropdownMenuItem>
            {/* The only route to revoking a link. Enabled whenever the session
                has project context — unlike Copy link it does not need a live
                preview, since the links you want to revoke usually outlive the
                app that produced them. */}
            <DropdownMenuItem
              onClick={() => setSharesOpen(true)}
              disabled={!projectId || !projectSessionId}
            >
              <Settings2 />
              {tHardcodedUi.raw('i18nComplete.texteb147164ac2a')}
              {liveShares.length > 0 && (
                <Badge variant="secondary" size="xs" className="ml-auto">
                  {liveShares.length}
                </Badge>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <SessionSharesModal
        projectId={projectId}
        sessionId={projectSessionId}
        open={sharesOpen}
        onOpenChange={setSharesOpen}
      />
      <PublicShareLinkConfirm confirmation={shareLink.confirmation} />

      {hasPreview ? (
        /* Iframe container */
        <div className="relative flex-1 overflow-hidden">
          {/* Loading overlay */}
          {isLoading && (
            <PreviewLoadingOverlay
              label={tHardcodedUi.raw(
                'componentsTabsPreviewTabContent.line481JsxTextLoadingPreview',
              )}
            />
          )}

          {/* Error state */}
          {hasError && (
            <ErrorState
              icon={AlertTriangle}
              size="sm"
              className="bg-background absolute inset-0 z-10"
              title={tHardcodedUi.raw(
                'componentsTabsPreviewTabContent.line492JsxTextFailedToLoadPreview',
              )}
              description={
                isExternalBrowsing
                  ? tHardcodedUi.raw('i18nComplete.texta29e5f4a270e')
                  : tI18nComplete('textfdf45589cf20', { value0: port })
              }
              action={
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRefresh}>
                  <RefreshCw className="size-3.5 shrink-0" />
                  {tHardcodedUi.raw('i18nComplete.text942087cc2d41')}
                </Button>
              }
            />
          )}

          <iframe
            key={refreshKey}
            src={previewUrl}
            title={
              isExternalBrowsing
                ? tI18nComplete('text62132c007f48', { value0: originalUrl })
                : tI18nComplete('text8d0218f233bb', { value0: port })
            }
            className="h-full w-full border-0"
            sandbox={framePolicy('app', previewUrl).sandbox}
            onLoad={handleLoad}
            onError={handleError}
          />
        </div>
      ) : (
        /* Landing — recent URLs when we have them, helper copy otherwise */
        <div className="flex-1 overflow-y-auto">
          {showRecents ? (
            <PreviewRecentsLanding
              recents={recents}
              onOpen={navigateTo}
              renderIcon={(url) =>
                isExternalUrl(url) ? (
                  <FaviconAvatar value={url} size="xs" className="shrink-0" />
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              icon={Globe}
              className="h-full"
              title={tHardcodedUi.raw(
                'autoComponentsTabsPreviewTabContentJsxTextPreviewBrowser8136da05',
              )}
              description={
                <>
                  {tHardcodedUi.raw('autoComponentsTabsPreviewTabContentJsxTextOpenAnAppda305669')}{' '}
                  <span className="text-foreground/80 font-mono">3000</span>{' '}
                  {tHardcodedUi.raw('autoComponentsTabsPreviewTabContentJsxTextIfYouKnow6745fa88')}
                </>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
