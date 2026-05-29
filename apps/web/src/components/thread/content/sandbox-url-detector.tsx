'use client';

import { useTranslations } from 'next-intl';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ExternalLink,
  Globe,
  MonitorPlay,
  Copy,
  Check,
  RefreshCw,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { UnifiedMarkdown } from '@/components/markdown';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import {
  detectLocalhostUrls,
  toInternalUrl,
  type DetectedLocalhostUrl,
} from '@/lib/utils/sandbox-url';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';

interface SandboxUrlDetectorProps {
  content: string;
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Reachability probe — lightweight HEAD fetch to check if a port is alive
// ---------------------------------------------------------------------------

type ReachabilityStatus = 'checking' | 'reachable' | 'unreachable';

function usePortReachability(proxyUrl: string): ReachabilityStatus {
  const [status, setStatus] = useState<ReachabilityStatus>('checking');

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        // no-cors gives an opaque response (status 0) but succeeds if the
        // server is listening. If the port is down, fetch throws a TypeError.
        await fetch(proxyUrl, {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-store',
          signal: AbortSignal.timeout(4000),
        });
        if (!cancelled) setStatus('reachable');
      } catch {
        if (!cancelled) setStatus('unreachable');
      }
    }

    probe();
    const interval = setInterval(probe, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [proxyUrl]);

  return status;
}

// ---------------------------------------------------------------------------
// Inline iframe preview — embedded directly in the chat thread
// ---------------------------------------------------------------------------

function InlineIframePreview({
  proxyUrl,
  port,
}: {
  proxyUrl: string;
  port: number;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Inject auth token for cloud preview proxy URLs
  const authenticatedUrl = useAuthenticatedPreviewUrl(proxyUrl);
  const isAuthReady = authenticatedUrl !== null;

  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
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
  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    setHasError(false);
    setRefreshKey((k) => k + 1);
  }, []);

  // Fallback: cross-origin iframes often don't fire onLoad.
  // Dismiss loading state after 5s regardless.
  useEffect(() => {
    if (!isLoading) return;
    clearLoadTimeout();
    loadTimeoutRef.current = setTimeout(() => {
      setIsLoading(false);
    }, 5000);
    return clearLoadTimeout;
  }, [isLoading, refreshKey, clearLoadTimeout]);

  return (
    <div
      className={cn(
        'mt-2 rounded-2xl border border-border/50 overflow-hidden transition-colors duration-200',
        expanded ? 'h-[480px]' : 'h-[280px]',
      )}
    >
      {/* Mini toolbar */}
      <div className="flex items-center gap-1.5 h-8 px-2.5 bg-muted/40 border-b border-border/30 shrink-0">
        <div className="flex-1 flex items-center gap-1.5 min-w-0">
          <Globe className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          <span className="text-xs text-muted-foreground font-mono truncate">
            localhost:{port}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleRefresh}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Refresh</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              {expanded ? (
                <Minimize2 className="h-3 w-3" />
              ) : (
                <Maximize2 className="h-3 w-3" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {expanded ? 'Collapse' : 'Expand'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Iframe — only render once auth token is ready */}
      <div className="relative flex-1 h-[calc(100%-2rem)]">
        {(isLoading || !isAuthReady) && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-xs">{!isAuthReady ? 'Authenticating...' : 'Loading...'}</span>
            </div>
          </div>
        )}
        {hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="text-center text-muted-foreground">
              <p className="text-xs">{tHardcodedUi.raw('componentsThreadContentSandboxUrlDetector.line186JsxTextFailedToLoad')}</p>
              <button
                onClick={handleRefresh}
                className="text-xs text-primary hover:underline mt-1"
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {isAuthReady && (
          <iframe
            key={refreshKey}
            ref={iframeRef}
            src={authenticatedUrl}
            title={`Preview :${port}`}
            className="w-full h-full border-0 bg-white"
            sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
            onLoad={handleLoad}
            onError={handleError}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SandboxPreviewCard — the inline card shown in chat
// ---------------------------------------------------------------------------

function SandboxPreviewCard({
  detected,
  proxyUrl,
}: {
  detected: DetectedLocalhostUrl;
  proxyUrl: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  const [showInlinePreview, setShowInlinePreview] = useState(true);
  const reachability = usePortReachability(proxyUrl);

  const isReachable = reachability === 'reachable';
  const isChecking = reachability === 'checking';

  const tabId = `preview:${detected.port}`;
  const tabHref = `/p/${detected.port}`;

  // The internal URL is what the user sees (the container-side address)
  const internalUrl = toInternalUrl(detected.port, detected.path);

  /** Open (or activate) the preview tab and navigate to it. */
  const navigateToPreviewTab = useCallback(() => {
    openTabAndNavigate({
      id: tabId,
      title: `localhost:${detected.port}`,
      type: 'preview',
      href: tabHref,
      metadata: enrichPreviewMetadata({
        url: proxyUrl,
        port: detected.port,
        originalUrl: internalUrl,
      }),
    });
  }, [detected, proxyUrl, internalUrl, tabId, tabHref]);

  const handleOpenExternal = useCallback(() => {
    window.open(proxyUrl, '_blank', 'noopener,noreferrer');
  }, [proxyUrl]);

  const handleCopyUrl = useCallback(() => {
    navigator.clipboard.writeText(proxyUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [proxyUrl]);

  const displayPath = detected.path !== '/' ? detected.path : '';

  return (
    <div className="my-3">
      <div className="group/card relative rounded-2xl border border-border/50 bg-muted/20 overflow-hidden transition-colors duration-200 hover:border-border/80 hover:bg-muted/30">
        {/* Top accent gradient — color reflects reachability */}
        <div className={cn(
          'absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent to-transparent',
          isReachable ? 'via-emerald-500/50' : isChecking ? 'via-amber-500/40' : 'via-red-500/40',
        )} />

        <div className="flex items-center gap-3 px-3.5 py-2.5">
          {/* Status icon */}
          <div className="relative flex-shrink-0">
            <div className={cn(
              'w-8 h-8 rounded-lg border flex items-center justify-center transition-colors',
              isReachable
                ? 'bg-emerald-500/8 border-emerald-500/15 group-hover/card:bg-emerald-500/12'
                : isChecking
                  ? 'bg-amber-500/8 border-amber-500/15'
                  : 'bg-red-500/8 border-red-500/15',
            )}>
              <Globe className={cn(
                'w-4 h-4',
                isReachable
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : isChecking
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-red-600 dark:text-red-400',
              )} />
            </div>
            {/* Status dot */}
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
              {isReachable && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400/50" />
              )}
              <span className={cn(
                'relative inline-flex rounded-full h-2.5 w-2.5 ring-[1.5px] ring-background',
                isReachable ? 'bg-emerald-500' : isChecking ? 'bg-amber-500 animate-pulse' : 'bg-red-500',
              )} />
            </span>
          </div>

          {/* Clickable URL — opens the preview tab */}
          <button
            onClick={navigateToPreviewTab}
            className="flex-1 min-w-0 text-left cursor-pointer group/link"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-semibold text-foreground tabular-nums group-hover/link:text-primary transition-colors">
                localhost:{detected.port}
              </span>
              {displayPath && (
                <span className="text-xs text-muted-foreground font-mono truncate group-hover/link:text-primary/70 transition-colors">
                  {displayPath}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground/60 leading-tight mt-0.5 group-hover/link:text-muted-foreground/80 transition-colors">
              {isReachable ? 'Service running' : isChecking ? 'Checking port...' : 'Port not reachable'}
            </p>
          </button>

          {/* Action buttons */}
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Inline preview toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 text-muted-foreground/50 hover:text-foreground',
                    showInlinePreview && 'text-primary bg-primary/8',
                  )}
                  onClick={() => setShowInlinePreview((v) => !v)}
                >
                  {showInlinePreview ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {showInlinePreview ? 'Hide preview' : 'Show inline preview'}
              </TooltipContent>
            </Tooltip>

            {/* Copy URL */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground/50 hover:text-foreground"
                  onClick={handleCopyUrl}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {copied ? 'Copied!' : 'Copy URL'}
              </TooltipContent>
            </Tooltip>

            {/* Open in browser */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground/50 hover:text-foreground"
                  onClick={handleOpenExternal}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{tHardcodedUi.raw('componentsThreadContentSandboxUrlDetector.line385JsxTextOpenInBrowser')}</TooltipContent>
            </Tooltip>

            {/* Open as tab — primary action */}
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs gap-1.5 px-3 ml-1 "
              onClick={navigateToPreviewTab}
            >
              <MonitorPlay className="h-3.5 w-3.5" />
              Preview
            </Button>
          </div>
        </div>

        {/* Inline iframe preview — toggleable */}
        {showInlinePreview && (
          <div className="px-3.5 pb-3">
            <InlineIframePreview proxyUrl={proxyUrl} port={detected.port} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SandboxUrlChip — compact chip for URLs found inside code blocks
// ---------------------------------------------------------------------------

/**
 * A lightweight, single-line chip for localhost URLs that were found inside
 * markdown code blocks. These are typically example/documentation URLs rather
 * than live services, so we show a minimal UI without an iframe or
 * reachability polling.
 */
function SandboxUrlChip({
  detected,
  proxyUrl,
}: {
  detected: DetectedLocalhostUrl;
  proxyUrl: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);

  const tabId = `preview:${detected.port}`;
  const tabHref = `/p/${detected.port}`;
  const internalUrl = toInternalUrl(detected.port, detected.path);

  const navigateToPreviewTab = useCallback(() => {
    openTabAndNavigate({
      id: tabId,
      title: `localhost:${detected.port}`,
      type: 'preview',
      href: tabHref,
      metadata: enrichPreviewMetadata({
        url: proxyUrl,
        port: detected.port,
        originalUrl: internalUrl,
      }),
    });
  }, [detected, proxyUrl, internalUrl, tabId, tabHref]);

  const handleCopyUrl = useCallback(() => {
    navigator.clipboard.writeText(proxyUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [proxyUrl]);

  const handleOpenExternal = useCallback(() => {
    window.open(proxyUrl, '_blank', 'noopener,noreferrer');
  }, [proxyUrl]);

  const displayPath = detected.path !== '/' ? detected.path : '';

  return (
    <div className="group/chip flex items-center gap-2 px-3 py-1.5 rounded-2xl border border-border/40 bg-muted/15 hover:border-border/60 hover:bg-muted/25 transition-colors">
      {/* Globe icon */}
      <Globe className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />

      {/* URL label — clickable to open preview tab */}
      <button
        onClick={navigateToPreviewTab}
        className="flex items-baseline gap-1 min-w-0 text-left group/link"
      >
        <span className="text-xs font-medium text-foreground/80 tabular-nums group-hover/link:text-primary transition-colors whitespace-nowrap">
          localhost:{detected.port}
        </span>
        {displayPath && (
          <span className="text-xs text-muted-foreground/60 font-mono truncate group-hover/link:text-primary/70 transition-colors">
            {displayPath}
          </span>
        )}
      </button>

      {/* Compact action buttons — only visible on hover */}
      <div className="flex items-center gap-0.5 ml-auto shrink-0 opacity-0 group-hover/chip:opacity-100 transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopyUrl}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{copied ? 'Copied!' : 'Copy URL'}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleOpenExternal}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{tHardcodedUi.raw('componentsThreadContentSandboxUrlDetector.line509JsxTextOpenInBrowser')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={navigateToPreviewTab}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              <MonitorPlay className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{tHardcodedUi.raw('componentsThreadContentSandboxUrlDetector.line521JsxTextOpenPreview')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SandboxUrlDetector — wraps markdown content + appends preview cards/chips
// ---------------------------------------------------------------------------

/**
 * Detects localhost URLs in assistant message content and renders
 * interactive preview elements after the full markdown content.
 *
 * URLs found in plain text get full preview cards with iframe embeds
 * (these typically represent live running services). URLs found inside
 * code blocks get compact chips (these are typically examples/docs
 * but can still be opened if the user wants to check).
 */
export const SandboxUrlDetector: React.FC<SandboxUrlDetectorProps> = ({
  content,
  isStreaming = false,
}) => {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Strip kortix_system XML tags before any processing/rendering.
  // These tags contain internal/system content injected by OpenCode plugins
  // that should not appear in the UI.
  const rawContent = typeof content === 'string' ? content : content ? String(content) : '';
  const safeContent = stripKortixSystemTags(rawContent);

  const { proxyUrl } = useSandboxProxy();

  const detected = useMemo(() => detectLocalhostUrls(safeContent), [safeContent]);

  const proxyUrls = useMemo(
    () => detected.map((d) => proxyUrl(d.originalUrl) ?? d.originalUrl),
    [detected, proxyUrl],
  );

  // Split into two tiers: live service URLs (plain text) vs example URLs (code blocks)
  const { liveUrls, codeBlockUrls } = useMemo(() => {
    const live: Array<{ detected: DetectedLocalhostUrl; proxyUrl: string }> = [];
    const code: Array<{ detected: DetectedLocalhostUrl; proxyUrl: string }> = [];
    detected.forEach((d, i) => {
      const entry = { detected: d, proxyUrl: proxyUrls[i] };
      if (d.inCodeBlock) {
        code.push(entry);
      } else {
        live.push(entry);
      }
    });
    return { liveUrls: live, codeBlockUrls: code };
  }, [detected, proxyUrls]);

  if (detected.length === 0) {
    return <UnifiedMarkdown content={safeContent} isStreaming={isStreaming} />;
  }

  return (
    <div>
      <UnifiedMarkdown content={safeContent} isStreaming={isStreaming} />

      {/* Plain-text localhost URLs are now rendered as inline preview cards
          directly inside UnifiedMarkdown — no separate SandboxPreviewCard needed. */}

      {/* Compact chips for URLs found inside code blocks (examples/docs) */}
      {codeBlockUrls.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground/50 font-medium uppercase tracking-wider">{tHardcodedUi.raw('componentsThreadContentSandboxUrlDetector.line590JsxTextEndpointsMentionedInCode')}</span>
          {codeBlockUrls.map(({ detected: d, proxyUrl }) => (
            <SandboxUrlChip
              key={`code-${d.port}-${d.path}`}
              detected={d}
              proxyUrl={proxyUrl}
            />
          ))}
        </div>
      )}
    </div>
  );
};
