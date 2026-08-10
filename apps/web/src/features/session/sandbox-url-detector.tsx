'use client';

import { useTranslations } from 'next-intl';

import { UnifiedMarkdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthenticatedPreviewUrl } from '@/hooks/use-authenticated-preview-url';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';
import { cn } from '@/lib/utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import {
  detectLocalhostUrls,
  toInternalUrl,
  type DetectedLocalhostUrl,
} from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { openTabAndNavigate } from '@/stores/tab-store';
import {
  CheckIcon as Check,
  CopyIcon as Copy,
  ArrowSquareOutIcon as ExternalLink,
  GlobeIcon as Globe,
  ArrowsOutSimpleIcon as Maximize2,
  ArrowsInSimpleIcon as Minimize2,
  MonitorPlayIcon as MonitorPlay,
  ArrowClockwiseIcon as RefreshCw,
} from '@phosphor-icons/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

function InlineIframePreview({ proxyUrl, port }: { proxyUrl: string; port: number }) {
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
        'border-border/50 mt-2 overflow-hidden rounded-2xl border transition-colors duration-200',
        expanded ? 'h-[480px]' : 'h-[280px]',
      )}
    >
      {/* Mini toolbar */}
      <div className="bg-muted/40 border-border/30 flex h-8 shrink-0 items-center gap-1.5 border-b px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Globe className="text-muted-foreground/50 h-3 w-3 shrink-0" />
          <span className="text-muted-foreground truncate font-mono text-xs">localhost:{port}</span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleRefresh}
              className="hover:bg-muted/60 text-muted-foreground/50 hover:text-muted-foreground rounded p-1 transition-colors"
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
              className="hover:bg-muted/60 text-muted-foreground/50 hover:text-muted-foreground rounded p-1 transition-colors"
            >
              {expanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{expanded ? 'Collapse' : 'Expand'}</TooltipContent>
        </Tooltip>
      </div>

      {/* Iframe — only render once auth token is ready */}
      <div className="relative h-[calc(100%-2rem)] flex-1">
        {(isLoading || !isAuthReady) && (
          <div className="bg-background/60 absolute inset-0 z-10 flex items-center justify-center">
            <div className="text-muted-foreground flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-xs">{!isAuthReady ? 'Authenticating...' : 'Loading...'}</span>
            </div>
          </div>
        )}
        {hasError && (
          <div className="bg-background absolute inset-0 z-10 flex items-center justify-center">
            <div className="text-muted-foreground text-center">
              <p className="text-xs">
                {tHardcodedUi.raw(
                  'componentsThreadContentSandboxUrlDetector.line186JsxTextFailedToLoad',
                )}
              </p>
              <button onClick={handleRefresh} className="text-primary mt-1 text-xs hover:underline">
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
            className="h-full w-full border-0 bg-white"
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
      <div className="group/card border-border/50 bg-muted/20 hover:border-border/80 hover:bg-muted/30 relative overflow-hidden rounded-2xl border transition-colors duration-200">
        {/* Top accent gradient — color reflects reachability */}
        <div
          className={cn(
            'absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent',
            isReachable ? 'via-emerald-500/50' : isChecking ? 'via-amber-500/40' : 'via-red-500/40',
          )}
        />

        <div className="flex items-center gap-3 px-3.5 py-2.5">
          {/* Status icon */}
          <div className="relative shrink-0">
            <div
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                isReachable
                  ? 'border-emerald-500/15 bg-emerald-500/8 group-hover/card:bg-emerald-500/12'
                  : isChecking
                    ? 'border-amber-500/15 bg-amber-500/8'
                    : 'border-red-500/15 bg-red-500/8',
              )}
            >
              <Globe
                className={cn(
                  'h-4 w-4',
                  isReachable
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : isChecking
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-red-600 dark:text-red-400',
                )}
              />
            </div>
            {/* Status dot */}
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
              {isReachable && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/50" />
              )}
              <span
                className={cn(
                  'ring-background relative inline-flex h-2.5 w-2.5 rounded-full ring-[1.5px]',
                  isReachable
                    ? 'bg-emerald-500'
                    : isChecking
                      ? 'animate-pulse bg-amber-500'
                      : 'bg-red-500',
                )}
              />
            </span>
          </div>

          {/* Clickable URL — opens the preview tab */}
          <button
            onClick={navigateToPreviewTab}
            className="group/link min-w-0 flex-1 cursor-pointer text-left"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-foreground group-hover/link:text-primary text-sm font-semibold tabular-nums transition-colors">
                localhost:{detected.port}
              </span>
              {displayPath && (
                <span className="text-muted-foreground group-hover/link:text-primary/70 truncate font-mono text-xs transition-colors">
                  {displayPath}
                </span>
              )}
            </div>
            <p className="text-muted-foreground/60 group-hover/link:text-muted-foreground/80 mt-0.5 text-xs leading-tight transition-colors">
              {isReachable
                ? 'Service running'
                : isChecking
                  ? 'Checking port...'
                  : 'Port not reachable'}
            </p>
          </button>

          {/* Action buttons */}
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Inline preview toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'text-muted-foreground/50 hover:text-foreground h-7 w-7',
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
                  className="text-muted-foreground/50 hover:text-foreground h-7 w-7"
                  onClick={handleCopyUrl}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{copied ? 'Copied!' : 'Copy URL'}</TooltipContent>
            </Tooltip>

            {/* Open in browser */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground/50 hover:text-foreground h-7 w-7"
                  onClick={handleOpenExternal}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {tHardcodedUi.raw(
                  'componentsThreadContentSandboxUrlDetector.line385JsxTextOpenInBrowser',
                )}
              </TooltipContent>
            </Tooltip>

            {/* Open as tab — primary action */}
            <Button
              variant="default"
              size="sm"
              className="ml-1 h-7 gap-1.5 px-3 text-xs"
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
    <div className="group/chip border-border/40 bg-muted/15 hover:border-border/60 hover:bg-muted/25 flex items-center gap-2 rounded-2xl border px-3 py-1.5 transition-colors">
      {/* Globe icon */}
      <Globe className="text-muted-foreground/50 h-3.5 w-3.5 shrink-0" />

      {/* URL label — clickable to open preview tab */}
      <button
        onClick={navigateToPreviewTab}
        className="group/link flex min-w-0 items-baseline gap-1 text-left"
      >
        <span className="text-foreground/80 group-hover/link:text-primary text-xs font-medium whitespace-nowrap tabular-nums transition-colors">
          localhost:{detected.port}
        </span>
        {displayPath && (
          <span className="text-muted-foreground/60 group-hover/link:text-primary/70 truncate font-mono text-xs transition-colors">
            {displayPath}
          </span>
        )}
      </button>

      {/* Compact action buttons — only visible on hover */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/chip:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopyUrl}
              className="hover:bg-muted/60 text-muted-foreground/40 hover:text-muted-foreground rounded p-1 transition-colors"
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
              className="hover:bg-muted/60 text-muted-foreground/40 hover:text-muted-foreground rounded p-1 transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {tHardcodedUi.raw(
              'componentsThreadContentSandboxUrlDetector.line509JsxTextOpenInBrowser',
            )}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={navigateToPreviewTab}
              className="hover:bg-muted/60 text-muted-foreground/40 hover:text-muted-foreground rounded p-1 transition-colors"
            >
              <MonitorPlay className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {tHardcodedUi.raw(
              'componentsThreadContentSandboxUrlDetector.line521JsxTextOpenPreview',
            )}
          </TooltipContent>
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
          <span className="text-muted-foreground/50 text-xs font-medium tracking-wider uppercase">
            {tHardcodedUi.raw(
              'componentsThreadContentSandboxUrlDetector.line590JsxTextEndpointsMentionedInCode',
            )}
          </span>
          {codeBlockUrls.map(({ detected: d, proxyUrl }) => (
            <SandboxUrlChip key={`code-${d.port}-${d.path}`} detected={d} proxyUrl={proxyUrl} />
          ))}
        </div>
      )}
    </div>
  );
};
