'use client';

import { useTranslations } from 'next-intl';

import { UnifiedMarkdown } from '@/components/markdown';
import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
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
import { probePreviewPort } from '@kortix/sdk';
import {
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
    const controller = new AbortController();

    async function probe() {
      // probePreviewPort asks the proxy, which answers 502/503/504 itself when
      // nothing is listening. 'unknown' (a CORS refusal, an offline browser, an
      // expired preview cookie) is evidence about us, not about the port, so it
      // must never overwrite a verdict we already have.
      const verdict = await probePreviewPort(proxyUrl, {
        signal: controller.signal,
        timeoutMs: 4000,
      });
      if (cancelled || verdict === 'unknown') return;
      setStatus(verdict);
    }

    probe();
    const interval = setInterval(probe, 10_000);
    return () => {
      cancelled = true;
      controller.abort();
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
    <div className="group/chip hover:bg-sidebar flex items-center gap-2 px-3 py-2">
      <Globe className="text-muted-foreground size-3.5 shrink-0" />

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
        <CopyButton code={proxyUrl} />
        <Hint
          label={tHardcodedUi.raw(
            'componentsThreadContentSandboxUrlDetector.line509JsxTextOpenInBrowser',
          )}
          side="top"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleOpenExternal}
            aria-label={tHardcodedUi.raw(
              'componentsThreadContentSandboxUrlDetector.line509JsxTextOpenInBrowser',
            )}
          >
            <ExternalLink className="size-4" />
          </Button>
        </Hint>

        <Hint
          label={tHardcodedUi.raw(
            'componentsThreadContentSandboxUrlDetector.line521JsxTextOpenPreview',
          )}
          side="top"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={navigateToPreviewTab}
            aria-label={tHardcodedUi.raw(
              'componentsThreadContentSandboxUrlDetector.line521JsxTextOpenPreview',
            )}
          >
            <MonitorPlay className="size-4" />
          </Button>
        </Hint>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CodeBlockEndpoints — self-contained chip list for localhost URLs in code
// ---------------------------------------------------------------------------

export type CodeBlockEndpointsProps = {
  /** Markdown (or plain) content to scan for localhost URLs inside code blocks. */
  content: string;
  className?: string;
};

/**
 * Detects localhost URLs inside markdown code blocks and renders compact chips.
 * Self-contained: strips system tags, resolves proxy URLs, returns null when empty.
 * Safe to mount anywhere a content string is available.
 */
export function CodeBlockEndpoints({ content, className }: CodeBlockEndpointsProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { proxyUrl } = useSandboxProxy();

  const rawContent = typeof content === 'string' ? content : content ? String(content) : '';
  const safeContent = stripKortixSystemTags(rawContent);

  const urls = useMemo(() => {
    const detected: { detected: DetectedLocalhostUrl; proxyUrl: string }[] = [];
    for (const d of detectLocalhostUrls(safeContent)) {
      if (!d.inCodeBlock) continue;
      detected.push({ detected: d, proxyUrl: proxyUrl(d.originalUrl) ?? d.originalUrl });
    }
    return detected;
  }, [safeContent, proxyUrl]);

  if (urls.length === 0) return null;

  return (
    <div
      className={cn(
        'bg-secondary flex flex-col divide-y overflow-hidden rounded-md border border-t',
        className,
      )}
    >
      {urls.map(({ detected: d, proxyUrl: resolved }) => (
        <SandboxUrlChip key={`code-${d.port}-${d.path}`} detected={d} proxyUrl={resolved} />
      ))}
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
  // Strip kortix_system XML tags before any processing/rendering.
  // These tags contain internal/system content injected by OpenCode plugins
  // that should not appear in the UI.
  const rawContent = typeof content === 'string' ? content : content ? String(content) : '';
  const safeContent = stripKortixSystemTags(rawContent);

  return <UnifiedMarkdown content={safeContent} isStreaming={isStreaming} />;
};
