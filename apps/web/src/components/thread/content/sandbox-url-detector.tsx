'use client';

import { useTranslations } from 'next-intl';

import React, { useCallback, useMemo, useState } from 'react';
import {
  ExternalLink,
  Globe,
  MonitorPlay,
  Copy,
  Check,
} from 'lucide-react';
import { UnifiedMarkdown } from '@/components/markdown';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import {
  detectLocalhostUrls,
  toInternalUrl,
  type DetectedLocalhostUrl,
} from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';

interface SandboxUrlDetectorProps {
  content: string;
  isStreaming?: boolean;
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

  const codeBlockUrls = useMemo(() => {
    const code: Array<{ detected: DetectedLocalhostUrl; proxyUrl: string }> = [];
    detected.forEach((d, i) => {
      const entry = { detected: d, proxyUrl: proxyUrls[i] };
      if (d.inCodeBlock) {
        code.push(entry);
      }
    });
    return code;
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
