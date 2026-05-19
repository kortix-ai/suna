'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Code2,
  ExternalLink,
  FileIcon,
  FileText,
  Globe,
  Image as ImageIcon,
  Maximize2,
  MonitorPlay,
  Music,
  RefreshCw,
  Type,
  Video,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import {
  isAppRouteUrl,
  isProxiableLocalhostUrl,
  parseLocalhostUrl,
} from '@/lib/utils/sandbox-url';
import { openTabAndNavigate } from '@/stores/tab-store';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { cn } from '@/lib/utils';
import { ShowContentRenderer, ShowCarousel, SHOW_HTML_EXT_RE } from '@/components/file-renderers/show-content-renderer';
import type { ShowCarouselItem } from '@/components/file-renderers/show-content-renderer';
import { SANDBOX_PORTS } from '@/lib/platform-client';
import { openSafeExternalUrl, safeHttpUrl } from '@/lib/safe-url';

/** Ensure a sandbox file path starts with /workspace/ for the static file server. */
function ensureWorkspacePath(filePath: string): string {
  if (filePath.startsWith('/workspace/')) return filePath;
  return '/workspace/' + filePath.replace(/^\/+/, '');
}

// ── Theme border styles — theme ONLY affects the card border color ──────────
const THEME_BORDER: Record<string, string> = {
  default: 'border-border',
  success: 'border-emerald-500/20',
  warning: 'border-amber-500/20',
  info:    'border-blue-500/20',
  danger:  'border-red-500/20',
};

function typeIcon(type: string) {
  switch (type) {
    case 'image':    return ImageIcon;
    case 'video':    return Video;
    case 'audio':    return Music;
    case 'code':     return Code2;
    case 'markdown': return Type;
    case 'html':     return Globe;
    case 'pdf':      return FileText;
    case 'url':      return Globe;
    case 'error':    return AlertTriangle;
    case 'file':     return FileIcon;
    default:         return FileIcon;
  }
}

// ---------------------------------------------------------------------------
// Embedded iframe preview for localhost URLs in the side-panel
// ---------------------------------------------------------------------------

function SidePanelIframePreview({ url, title }: { url: string; title?: string }) {
  const { proxyUrl } = useSandboxProxy();

  const proxy = useMemo(() => {
    if (!url) return null;
    if (!isProxiableLocalhostUrl(url)) return null;
    const parsed = parseLocalhostUrl(url);
    if (!parsed) return null;
    const resolvedProxyUrl = proxyUrl(url);
    if (!resolvedProxyUrl) return null;
    return { proxyUrl: resolvedProxyUrl, port: parsed.port };
  }, [url, proxyUrl]);

  const externalUrl = proxy ? null : safeHttpUrl(url);
  const authenticatedProxyUrl = useAuthenticatedPreviewUrl(proxy?.proxyUrl || '');
  const previewUrl = proxy ? authenticatedProxyUrl : externalUrl;
  const isAuthReady = previewUrl !== null;
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // ── Scaled 1920x1080 viewport ──
  const viewportRef = useRef<HTMLDivElement>(null);
  const [vpScale, setVpScale] = useState(0);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setVpScale(Math.min(w / 1920, h / 1080));
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!isLoading) return;
    const t = setTimeout(() => setIsLoading(false), 5000);
    return () => clearTimeout(t);
  }, [isLoading, refreshKey]);

  const displayLabel = title || (proxy ? `localhost:${proxy.port}` : url);

  const navigateToPreviewTab = useCallback(() => {
    if (!proxy) return;
    openTabAndNavigate({
      id: `preview:${proxy.port}`,
      title: `localhost:${proxy.port}`,
      type: 'preview',
      href: `/p/${proxy.port}`,
      metadata: enrichPreviewMetadata({
        url: proxy.proxyUrl,
        port: proxy.port,
        originalUrl: url,
      }),
    });
  }, [proxy, url]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 h-9 px-3 bg-muted/30 border-b border-border/30 shrink-0">
        <Globe className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
        <span className="text-xs text-muted-foreground font-mono truncate flex-1">{displayLabel}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" onClick={handleRefresh} variant="ghost" size="icon-xs">
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Refresh</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" onClick={() => previewUrl && openSafeExternalUrl(previewUrl)} disabled={!isAuthReady} variant="ghost" size="icon-xs">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Open in browser</TooltipContent>
        </Tooltip>
        {proxy && (
          <Button variant="subtle" size="xs" onClick={navigateToPreviewTab}>
            <MonitorPlay className="h-3 w-3" />
            Open Tab
          </Button>
        )}
      </div>
      {/* Scaled 1920x1080 viewport — fits within available panel space */}
      <div ref={viewportRef} className="relative flex-1 min-h-0 overflow-hidden bg-white">
        {(isLoading || !isAuthReady) && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-xs">{!isAuthReady ? 'Authenticating...' : 'Loading preview...'}</span>
            </div>
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="text-center text-muted-foreground">
              <p className="text-sm">Failed to load preview</p>
              <Button type="button" onClick={handleRefresh} variant="link" size="sm" className="mt-1 h-auto p-0 text-xs">Retry</Button>
            </div>
          </div>
        )}
        {isAuthReady && vpScale > 0 && (
          <iframe
            key={refreshKey}
            src={previewUrl ?? undefined}
            title={displayLabel}
            className="border-0 bg-white"
            style={{
              width: '1920px',
              height: '1080px',
              transform: `scale(${vpScale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0,
              left: 0,
            }}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals"
            onLoad={() => setIsLoading(false)}
            onError={() => { setIsLoading(false); setHasError(true); }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scaled external URL iframe for the side-panel
// ---------------------------------------------------------------------------

function ScaledExternalIframe({ url, title }: { url: string; title?: string }) {
  const safeUrl = safeHttpUrl(url);
  const vpRef = useRef<HTMLDivElement>(null);
  const [vpScale, setVpScale] = useState(0);
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setVpScale(Math.min(w / 1920, h / 1080));
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 h-9 px-3 bg-muted/30 border-b border-border/30 shrink-0">
        <Globe className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
        <span className="text-xs text-muted-foreground font-mono truncate flex-1">{safeUrl ?? url}</span>
        {safeUrl && (
          <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-muted/60 text-muted-foreground/50 hover:text-muted-foreground transition-colors">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      <div ref={vpRef} className="relative flex-1 min-h-0 overflow-hidden bg-white">
        {safeUrl && vpScale > 0 && (
          <iframe
            src={safeUrl}
            title={title || safeUrl}
            className="border-0 bg-white"
            style={{
              width: '1920px',
              height: '1080px',
              transform: `scale(${vpScale})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0,
              left: 0,
            }}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component — side-panel renderer
// Uses ShowContentRenderer as single source of truth for content rendering.
// This component only handles the card chrome (header, footer, tabs).
// ---------------------------------------------------------------------------

export function OcShowUserToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;

  // ── Extract fields ──
  const title       = (args.title as string)       || (ocState?.input?.title as string)       || '';
  const description = (args.description as string) || (ocState?.input?.description as string) || '';
  const type        = (args.type as string)        || (ocState?.input?.type as string)        || '';
  const path        = (args.path as string)        || (ocState?.input?.path as string)        || '';
  const url         = (args.url as string)         || (ocState?.input?.url as string)         || '';
  const content     = (args.content as string)     || (ocState?.input?.content as string)     || '';
  const aspectRatio = (args.aspect_ratio as string) || (ocState?.input?.aspect_ratio as string) || '';
  const theme       = (args.theme as string)       || (ocState?.input?.theme as string)       || 'default';
  const language    = (args.language as string)    || (ocState?.input?.language as string)    || '';

  // ── Parse items[] for multi-item carousel mode ──
  const rawItems = args.items || (ocState?.input?.items);
  const items = useMemo<ShowCarouselItem[] | null>(() => {
    if (!rawItems) return null;
    try {
      const parsed = typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* ignore */ }
    return null;
  }, [rawItems]);

  const isCarousel = !!items && items.length > 0;

  // ── Track current carousel item for Open File ──
  const [carouselIndex, setCarouselIndex] = useState(0);
  const currentCarouselItem = isCarousel ? items![carouselIndex] || items![0] : null;

  const borderStyle = THEME_BORDER[theme] || THEME_BORDER.default;
  const Icon = isCarousel
    ? typeIcon(currentCarouselItem?.type || items![0].type || '')
    : typeIcon(type);

  const isError = type === 'error' || toolResult?.success === false || !!toolResult?.error;
  const hasLocalhostUrl = !!parseLocalhostUrl(url) && !isAppRouteUrl(url);

  // ── Shared proxy state (for header subtitle + previews) ──
  const { proxyUrl } = useSandboxProxy();
  const resolvedUrl = useMemo(
    () => proxyUrl(url) ?? url,
    [url, proxyUrl],
  );
  const safeResolvedUrl = safeHttpUrl(resolvedUrl);
  const safeUrl = safeHttpUrl(url);

  const displayTitle = isCarousel
    ? (title || `${items!.length} items`)
    : (title || description || 'Output');

  // ── Footer badge — always neutral colors, NEVER themed ──
  const footerBadge = useMemo(() => {
    if (isStreaming) return null;
    if (isError && type === 'error') {
      return (
        <Badge variant="outline" className="h-6 py-0.5 bg-muted">
          <AlertTriangle className="h-3 w-3 text-red-500" />
          Error
        </Badge>
      );
    }
    if (hasLocalhostUrl) {
      return (
        <Badge variant="outline" className="h-6 py-0.5 bg-muted">
          <CheckCircle className="h-3 w-3 text-muted-foreground" />
          Live Preview
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="h-6 py-0.5 bg-muted">
        <CheckCircle className="h-3 w-3 text-muted-foreground" />
        Displayed
      </Badge>
    );
  }, [isStreaming, isError, type, hasLocalhostUrl]);

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCALHOST URL → full iframe preview
  // ═══════════════════════════════════════════════════════════════════════════
  if (hasLocalhostUrl) {
    return (
      <Card className={cn("gap-0 flex shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card border-0", borderStyle)}>
        <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle icon={Globe} title={displayTitle} subtitle={safeResolvedUrl || undefined} />
            {safeResolvedUrl && (
              <a href={safeResolvedUrl} target="_blank" rel="noopener noreferrer" className="p-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0 h-full flex-1 overflow-hidden">
          <SidePanelIframePreview url={url} title={title || description || undefined} />
        </CardContent>
        <ToolViewFooter assistantTimestamp={assistantTimestamp} toolTimestamp={toolTimestamp} isStreaming={isStreaming}>
          {footerBadge}
        </ToolViewFooter>
      </Card>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTERNAL URL → full iframe preview
  // ═══════════════════════════════════════════════════════════════════════════
  if (type === 'url' && safeUrl && !hasLocalhostUrl) {
    return (
      <Card className={cn("gap-0 flex shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card border-0", borderStyle)}>
        <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle icon={Globe} title={displayTitle} subtitle={safeUrl} />
            <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="p-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </CardHeader>
        <CardContent className="p-0 h-full flex-1 overflow-hidden">
          <ScaledExternalIframe url={safeUrl} title={title || undefined} />
        </CardContent>
        <ToolViewFooter assistantTimestamp={assistantTimestamp} toolTimestamp={toolTimestamp} isStreaming={isStreaming}>
          {footerBadge}
        </ToolViewFooter>
      </Card>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAROUSEL — multiple items in a single show call
  // ═══════════════════════════════════════════════════════════════════════════
  if (isCarousel) {
    const ciPath = currentCarouselItem?.path || '';
    const ciUrl = currentCarouselItem?.url || '';
    const ciType = currentCarouselItem?.type || '';
    const ciTitle = currentCarouselItem?.title || '';
    const ciHasLocalhostUrl = !!parseLocalhostUrl(ciUrl) && !isAppRouteUrl(ciUrl);
    const ciIsHtmlFile = !!ciPath && SHOW_HTML_EXT_RE.test(ciPath) && (ciType === 'file' || ciType === 'html');
    const ciCanOpen = !!(ciUrl || ciPath);
    const ciOpenLabel = ciIsHtmlFile ? 'Open Preview' : ciHasLocalhostUrl ? 'Open in Tab' : ciUrl ? 'Open Link' : 'Open File';

    const handleCarouselOpen = () => {
      if (ciIsHtmlFile && ciPath) {
        const staticPort = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);
        const normalizedCiPath = ensureWorkspacePath(ciPath);
        const staticUrl = `http://localhost:${staticPort}/open?path=${encodeURIComponent(normalizedCiPath)}`;
        const proxy = proxyUrl(staticUrl);
        if (proxy) {
          const parsed = parseLocalhostUrl(staticUrl);
          openTabAndNavigate({
            id: `preview:${parsed?.port || staticPort}`,
            title: ciTitle || ciPath.split('/').pop() || ciPath,
            type: 'preview',
            href: `/p/${parsed?.port || staticPort}`,
            metadata: enrichPreviewMetadata({
              url: proxy,
              port: parsed?.port || staticPort,
              originalUrl: staticUrl,
            }),
          });
          return;
        }
      }
      if (ciHasLocalhostUrl && ciUrl) {
        const proxy = proxyUrl(ciUrl);
        const parsed = parseLocalhostUrl(ciUrl);
        if (proxy && parsed) {
          openTabAndNavigate({
            id: `preview:${parsed.port}`,
            title: ciTitle || `localhost:${parsed.port}`,
            type: 'preview',
            href: `/p/${parsed.port}`,
            metadata: enrichPreviewMetadata({
              url: proxy,
              port: parsed.port,
              originalUrl: ciUrl,
            }),
          });
          return;
        }
      }
      if (ciUrl) {
        openSafeExternalUrl(ciUrl);
        return;
      }
      if (ciPath) {
        const fileName = ciPath.split('/').pop() || ciPath;
        openTabAndNavigate({
          id: `file:${ciPath}`,
          title: fileName,
          type: 'file',
          href: `/files/${encodeURIComponent(ciPath)}`,
        });
      }
    };

    return (
      <Card className={cn("gap-0 flex shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card border-0", borderStyle)}>
        <CardHeader className="h-14 backdrop-blur-sm border-b p-2 px-4 space-y-2 bg-muted/50">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle icon={Icon} title={displayTitle} subtitle={description || undefined} />
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground/60 font-medium">
                {items!.length} items
              </span>
              {ciCanOpen && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1 px-2"
                  onClick={handleCarouselOpen}
                >
                  {(ciIsHtmlFile || ciHasLocalhostUrl) ? <MonitorPlay className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                  {ciOpenLabel}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 h-full flex-1 overflow-hidden">
          <ScrollArea className="h-full w-full">
            <ShowCarousel items={items!} LocalhostPreview={SidePanelIframePreview} onIndexChange={setCarouselIndex} />
          </ScrollArea>
        </CardContent>
        <ToolViewFooter assistantTimestamp={assistantTimestamp} toolTimestamp={toolTimestamp} isStreaming={isStreaming}>
          {footerBadge}
        </ToolViewFooter>
      </Card>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Everything else — ShowContentRenderer handles all content types
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <Card className={cn("gap-0 flex shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card border-0", borderStyle)}>
      <CardHeader className="h-14 backdrop-blur-sm border-b p-2 px-4 space-y-2 bg-muted/50">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Icon} title={displayTitle} subtitle={path || url || language || undefined} />
          <div className="flex items-center gap-2 flex-shrink-0">
            {safeUrl && (
              <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="p-1 text-muted-foreground hover:text-foreground transition-colors">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {type && (
              <span className={cn(
                'text-[10px] px-2 py-0.5 rounded-md font-medium uppercase tracking-wider',
                type === 'error'
                  ? 'bg-red-500/[0.08] text-red-500/85'
                  : 'bg-foreground/[0.04] text-muted-foreground/70',
              )}>
                {type}
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <ShowContentRenderer
            type={type}
            title={title}
            description={description}
            path={path}
            url={url}
            content={content}
            language={language}
            aspectRatio={aspectRatio}
          />

          {/* ── Description below content (when title exists) ── */}
          {description && title && type !== 'code' && type !== 'markdown' && (
            <div className="px-4 py-3 border-t border-border/20">
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          )}

          {/* ── Generic error from toolResult ── */}
          {isError && type !== 'error' && (
            <div className="flex items-start gap-2.5 p-4 text-muted-foreground border-t border-border/20">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <p className="text-sm">{toolResult?.error || 'Operation failed'}</p>
            </div>
          )}
        </ScrollArea>
      </CardContent>

      <ToolViewFooter assistantTimestamp={assistantTimestamp} toolTimestamp={toolTimestamp} isStreaming={isStreaming}>
        {footerBadge}
      </ToolViewFooter>
    </Card>
  );
}
