'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { framePolicy, serviceFrameContent } from '@/features/file-viewer/preview-policy';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import { prefersPreviewLink, safeHttpUrl } from '@kortix/shared';
import { ToolSurfaceContext } from './surface';
import { ToolActionBar } from './tool-action-bar';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { useTranslations } from '@/i18n/use-translations';
import { openSafeExternalUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { isProxiableLocalhostUrl, parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata, getActiveSessionContext } from '@/lib/utils/session-context';
import { getActivePanelSessionId, sessionPreviewTabId } from '@/stores/session-browser-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import { ArrowClockwiseIcon, ArrowSquareOutIcon, GlobeIcon as Globe } from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const MD_FLUSH_CLASSES =
  '[&_.relative.group]:my-0 [&_pre]:my-0 [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:rounded-none [&_pre]:text-xs [&_code]:text-xs';

export const ToolNavigationContext = createContext(true);

export function useToolNavigation() {
  const enabled = useContext(ToolNavigationContext);

  const openTab = useCallback(
    (tab: Parameters<typeof openTabAndNavigate>[0]) => {
      if (!enabled) return;
      openTabAndNavigate(tab);
    },
    [enabled],
  );

  const openExternal = useCallback(
    (targetUrl?: string) => {
      if (!enabled || !targetUrl) return;
      openSafeExternalUrl(targetUrl);
    },
    [enabled],
  );

  return { enabled, openTab, openExternal };
}

export function useProxyUrl(localhostUrl: string): { proxyUrl: string; port: number } | null {
  const { proxyUrl } = useSandboxProxy();

  return useMemo(() => {
    if (!localhostUrl) return null;
    if (!isProxiableLocalhostUrl(localhostUrl)) return null;
    const parsed = parseLocalhostUrl(localhostUrl);
    if (!parsed) return null;
    const resolvedProxyUrl = proxyUrl(localhostUrl);
    if (!resolvedProxyUrl) return null;
    return {
      proxyUrl: resolvedProxyUrl,
      port: parsed.port,
    };
  }, [localhostUrl, proxyUrl]);
}

export function isLocalSandboxFilePath(value: string): boolean {
  if (!value) return false;
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  return value.startsWith('/');
}

export function useServicePreview(url: string, label?: string, sessionId?: string) {
  const { enabled: navigationEnabled, openTab, openExternal } = useToolNavigation();
  const proxy = useProxyUrl(url);
  const externalUrl = proxy ? null : safeHttpUrl(url);
  const authenticatedProxyUrl = useAuthenticatedPreviewUrl(proxy?.proxyUrl || '');
  const previewUrl = proxy ? authenticatedProxyUrl : externalUrl;
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!isLoading || !previewUrl) return;
    const t = setTimeout(() => {
      setIsLoading(false);
      setHasError(true);
    }, 8000);
    return () => clearTimeout(t);
  }, [isLoading, previewUrl, refreshKey]);

  const displayLabel = label || (proxy ? 'App preview' : url);

  const navigateToPreviewTab = useCallback(() => {
    if (!navigationEnabled || !proxy) return;
    const parsed = parseLocalhostUrl(url);
    const sid =
      sessionId || getActivePanelSessionId() || getActiveSessionContext()?.sourceSessionId || null;

    if (sid && parsed) {
      useTabStore.getState().openTab({
        id: sessionPreviewTabId(sid),
        title: label || 'App preview',
        type: 'preview',
        href: typeof window !== 'undefined' ? window.location.pathname : `/p/${proxy.port}`,
        metadata: enrichPreviewMetadata({
          url: proxy.proxyUrl,
          port: proxy.port,
          originalUrl: url,
          path: parsed.path,
        }),
      });
      // Route through the shared, mode-aware entry point rather than writing
      // `viewBySession` directly: that key is read only by Advanced mode, so
      // in Easy — the only mode that ships — this opened the panel on the Easy
      // home and dropped the page entirely. The target carries WHICH page, so
      // the browser lands on this preview instead of the first running app.
      openSessionQuickView('browser', 'preview', {
        url: proxy.proxyUrl,
        title: label || 'App preview',
      });
      return;
    }

    openTab({
      id: `preview:${proxy.port}`,
      title: label || 'App preview',
      type: 'preview',
      href: `/p/${proxy.port}`,
      metadata: enrichPreviewMetadata({
        url: proxy.proxyUrl,
        port: proxy.port,
        originalUrl: url,
      }),
    });
  }, [navigationEnabled, openTab, proxy, url, label, sessionId]);

  const openInBrowser = useCallback(() => {
    openExternal(previewUrl ?? undefined);
  }, [openExternal, previewUrl]);

  const onLoad = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
  }, []);
  const onError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  return {
    navigationEnabled,
    proxy,
    previewUrl,
    /** A static file the agent wrote (`document`) or a server it runs (`app`). */
    frameContent: serviceFrameContent(proxy?.port),
    isLoading,
    hasError,
    refreshKey,
    handleRefresh,
    displayLabel,
    navigateToPreviewTab,
    openInBrowser,
    onLoad,
    onError,
  };
}

export type ServicePreviewState = ReturnType<typeof useServicePreview>;

// Single home for the preview controls (refresh / open externally / open as tab)
// so they never render twice around the same iframe.
export function ServicePreviewActions({
  preview,
  compact = false,
}: {
  preview: ServicePreviewState;
  /** Fold Refresh and Open in browser into one ⋯ menu, leaving Preview as the
   *  only visible action (the inline carousel header needs the room). */
  compact?: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const {
    navigationEnabled,
    proxy,
    previewUrl,
    isLoading,
    handleRefresh,
    navigateToPreviewTab,
    openInBrowser,
  } = preview;

  const previewButton = (
    <Hint
      label={tHardcodedUi.raw('componentsSessionToolRenderers.line5032JsxTextOpenAsTab')}
      side="top"
    >
      <Button
        type="button"
        onClick={navigateToPreviewTab}
        size="xs"
        disabled={!navigationEnabled || !proxy}
      >
        {tHardcodedUi.raw('i18nComplete.text324b134f57c7')}
      </Button>
    </Hint>
  );

  return (
    <ToolActionBar
      compact={compact}
      loading={isLoading}
      refreshLabel={tHardcodedUi.raw('i18nComplete.text0e9161011702')}
      menuLabel={tHardcodedUi.raw('i18nComplete.textf8d46c2570e7')}
      onRefresh={handleRefresh}
      secondaryLabel={tHardcodedUi.raw(
        'autoFeaturesSessionToolRenderersJsxTextOpenPrivatePreview0d54e929',
      )}
      secondaryIcon={ArrowSquareOutIcon}
      secondaryIconClassName="size-4.5"
      onSecondary={openInBrowser}
      secondaryDisabled={!navigationEnabled || !previewUrl}
      secondaryDisabledClassName="cursor-not-allowed opacity-50"
      primary={previewButton}
    />
  );
}

export function ServicePreviewUrlFallback({ preview }: { preview: ServicePreviewState }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { previewUrl, displayLabel, handleRefresh, openInBrowser, isLoading, navigationEnabled } =
    preview;
  // NEVER the previewUrl: on a preview origin it carries a one-shot `?token=`
  // (the user's live Supabase JWT), and this renders as visible page text —
  // screenshot- and screen-share-capturable. previewUrl stays in the click
  // handler, where it is used and not shown.
  const label = displayLabel;

  return (
    <div className="bg-background absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="flex max-w-2xl flex-col items-center gap-3 text-center">
        <Hint
          label={tI18nHardcoded.raw(
            'autoFeaturesSessionToolRenderersJsxTextOpenPrivatePreview0d54e929',
          )}
          side="top"
        >
          <Button
            type="button"
            variant="outline"
            onClick={openInBrowser}
            disabled={!navigationEnabled || !previewUrl}
            className={cn(
              'inline-flex h-auto max-w-full items-center gap-2 px-4 py-3 font-mono text-sm font-medium shadow-2xs',
              navigationEnabled && previewUrl ? '' : 'cursor-not-allowed opacity-60',
            )}
          >
            <ArrowSquareOutIcon className="text-muted-foreground size-4 shrink-0" />
            <span className="break-all">{label}</span>
          </Button>
        </Hint>
        <Hint label={tI18nHardcoded.raw('i18nComplete.text0e9161011702')} side="top">
          <Button
            variant="ghost"
            size="xs"
            type="button"
            onClick={handleRefresh}
            className="text-muted-foreground gap-1.5"
          >
            {isLoading ? (
              <Loading className="size-3.5" />
            ) : (
              <ArrowClockwiseIcon className="size-3.5" />
            )}
            {tI18nHardcoded.raw('i18nComplete.textceba35272869')}
          </Button>
        </Hint>
      </div>
    </div>
  );
}

export function ServicePreviewViewport({
  preview,
  slotHeight = false,
}: {
  preview: ServicePreviewState;
  /** Take the inline carousel's fixed 420px slot instead of a 16:9 box, so a
   *  port slide is exactly as tall as an image or PDF slide: no gap under the
   *  frame, and no height jump when switching items. */
  slotHeight?: boolean;
}) {
  const fill = useContext(ToolSurfaceContext) === 'panel';
  const {
    previewUrl,
    frameContent,
    displayLabel,
    isLoading,
    hasError,
    refreshKey,
    onLoad,
    onError,
  } = preview;
  const linkOnlyPreview = prefersPreviewLink(previewUrl);
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <div
      className={cn(
        'bg-secondary relative w-full overflow-hidden',
        fill ? 'h-full' : slotHeight ? 'h-[420px]' : 'aspect-video',
      )}
    >
      {(isLoading || !previewUrl) && !linkOnlyPreview && (
        <div className="bg-background/60 absolute inset-0 z-10 flex items-center justify-center">
          <div className="text-muted-foreground flex items-center gap-2">
            <Loading />
            <span className="text-xs">
              {tHardcodedUi.raw('componentsSessionToolRenderers.line380JsxTextLoadingPreview')}
            </span>
          </div>
        </div>
      )}
      {(hasError || linkOnlyPreview) && <ServicePreviewUrlFallback preview={preview} />}
      {previewUrl && !linkOnlyPreview && (
        <iframe
          key={refreshKey}
          src={previewUrl}
          title={displayLabel}
          className="bg-secondary absolute inset-0 h-full w-full border-0"
          // The agent chose what this frame shows; `framePolicy` decides its
          // sandbox and origin (see `FrameContent`).
          sandbox={framePolicy(frameContent, previewUrl).sandbox}
          onLoad={onLoad}
          onError={onError}
        />
      )}
    </div>
  );
}

export function InlineServicePreview({ url, label }: { url: string; label?: string }) {
  const fill = useContext(ToolSurfaceContext) === 'panel';
  const preview = useServicePreview(url, label);
  const { displayLabel } = preview;

  return (
    <div className={cn('overflow-hidden', fill && 'flex h-full flex-col')}>
      <div className="bg-muted/40 border-border/30 flex h-8 shrink-0 items-center gap-1.5 border-b px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Globe className="text-muted-foreground/50 h-3 w-3 shrink-0" />
          <span className="text-muted-foreground truncate font-mono text-xs">{displayLabel}</span>
        </div>
      </div>

      {fill ? (
        <div className="min-h-0 flex-1">
          <ServicePreviewViewport preview={preview} />
        </div>
      ) : (
        <ServicePreviewViewport preview={preview} />
      )}
    </div>
  );
}
