'use client';

import {
  BasicTool,
  looksLikeError,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { extractReadableHtml } from '@/features/session/tool/tool-renderers-sanitization';
import { openSafeExternalUrl, safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import {
  CaretRightIcon as ChevronRight,
  ArrowSquareOutIcon as ExternalLink,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { looksLikeHtml, wsDomain } from '@/features/session/tool/shared/web-helpers';

export function WebFetchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const url = (input.url as string) || '';
  const format = (input.format as string) || '';
  // Both of these parse the URL. `new URL()` twice per render, per fetched page
  // on screen, for a string that only changes when the part does.
  const domain = useMemo(() => (url ? wsDomain(url) : ''), [url]);
  const safeUrl = useMemo(() => safeHttpUrl(url), [url]);
  const [rawOpen, setRawOpen] = useState(false);
  const openUrl = useCallback(() => openSafeExternalUrl(url), [url]);

  // `looksLikeHtml` lowercases the first 600 chars then runs a regex over the
  // first 3000; `looksLikeError` copies the ENTIRE body via `trim()` before it
  // can bail on length. A fetched page is routinely tens of kilobytes, and none
  // of this was memoised — it ran on every render, open or collapsed.
  const isHtml = useMemo(
    () => format === 'html' || (!format && looksLikeHtml(output)),
    [format, output],
  );
  const readable = useMemo(
    () => (isHtml && output ? extractReadableHtml(output) : null),
    [isHtml, output],
  );
  const isError = useMemo(
    () => status !== 'running' && looksLikeError(output),
    [status, output],
  );
  const errorSummary = useMemo(
    () => (isError ? output.replace(/^Error:\s*/i, '').trim() : ''),
    [isError, output],
  );

  // Both previews were sliced inline in JSX, so a 4 KB and an 8 KB string were
  // copied per render — the raw one even while its disclosure stayed closed,
  // because the children of `DisclosureContent` are built either way.
  const readableText = useMemo(() => readable?.text.slice(0, 4000) ?? '', [readable]);
  const rawHtmlPreview = useMemo(() => output.slice(0, 8000), [output]);

  // The page's own title + domain, favicon leading — not the verb "Web
  // Fetch". A non-technical reader recognizes a fetched page by its title,
  // the way a browser tab does; the favicon is what says "this is a website"
  // without a word having to.
  const pageTitle = readable?.title?.trim();
  const showDomainSubtitle = Boolean(pageTitle && pageTitle !== domain);

  return (
    <BasicTool
      icon={<FaviconAvatar value={safeUrl ?? url} size="xs" className="shrink-0" />}
      trigger={{
        title: pageTitle || domain || url,
        subtitle: showDomainSubtitle ? domain : undefined,
        args: format ? [format] : undefined,
      }}
      rightAccessory={safeUrl ? <ExternalLink /> : undefined}
      onSubtitleClick={safeUrl ? openUrl : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {!output ? null : isError && safeUrl ? (
        <div data-scrollable className="max-h-[28rem] overflow-auto">
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-component="web-source-row"
            className="group border-border/40 hover:bg-muted/30 flex items-center gap-2 border-b px-3 py-2"
          >
            <FaviconAvatar value={url} size="xs" className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="text-foreground group-hover:text-primary block truncate text-xs font-medium">
                {domain}
              </span>
              <span className="text-muted-foreground/50 block truncate font-mono text-[10px]">
                {domain}
              </span>
            </span>
            <ExternalLink className="text-muted-foreground/30 group-hover:text-muted-foreground/60 size-3 shrink-0" />
          </a>
          <p className="text-muted-foreground/80 px-3 py-2 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
            {errorSummary}
          </p>
        </div>
      ) : readable ? (
        <div data-scrollable className="max-h-[28rem] overflow-auto">
          <a
            href={safeUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            data-component="web-source-row"
            className="group border-border/40 hover:bg-muted/30 flex items-center gap-2 border-b px-3 py-2"
          >
            <FaviconAvatar value={url} size="xs" className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="text-foreground group-hover:text-primary block truncate text-xs font-medium">
                {readable.title || domain}
              </span>
              <span className="text-muted-foreground/50 block truncate font-mono text-[10px]">
                {domain}
              </span>
            </span>
            <ExternalLink className="text-muted-foreground/30 group-hover:text-muted-foreground/60 size-3 shrink-0" />
          </a>

          <p className="text-foreground/80 px-3 py-2 text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
            {readableText || 'No readable text content.'}
          </p>

          <Disclosure open={rawOpen} onOpenChange={setRawOpen}>
            <DisclosureTrigger>
              <button
                type="button"
                className="border-border/40 text-muted-foreground/60 hover:text-foreground flex w-full items-center gap-1.5 border-t px-3 py-2 text-xs transition-colors"
              >
                <ChevronRight
                  className={cn('size-3 transition-transform', rawOpen && 'rotate-90')}
                />
                {tI18nHardcoded.raw('autoFeaturesSessionToolRenderersJsxTextViewRawHTMLa2f4484f')}
              </button>
            </DisclosureTrigger>
            <DisclosureContent>
              <pre className="text-muted-foreground/70 max-h-72 overflow-auto px-3 pb-2 font-mono text-[11px] leading-relaxed wrap-break-word whitespace-pre-wrap">
                {rawHtmlPreview}
              </pre>
            </DisclosureContent>
          </Disclosure>
        </div>
      ) : (
        <ToolOutputFallback
          output={output}
          isStreaming={status === 'running'}
          toolName="web_fetch"
        />
      )}
    </BasicTool>
  );
}
ToolRegistry.register('webfetch', WebFetchTool);
ToolRegistry.register('web_fetch', WebFetchTool);
