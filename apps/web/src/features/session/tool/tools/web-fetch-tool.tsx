'use client';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { ChevronRight, ExternalLink, Globe } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { looksLikeHtml, wsDomain } from '@/features/session/tool/shared/web-helpers';

export function WebFetchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const url = (input.url as string) || '';
  const format = (input.format as string) || '';
  const domain = url ? wsDomain(url) : '';
  const safeUrl = safeHttpUrl(url);
  const [rawOpen, setRawOpen] = useState(false);

  const isHtml = format === 'html' || (!format && looksLikeHtml(output));
  const readable = useMemo(
    () => (isHtml && output ? extractReadableHtml(output) : null),
    [isHtml, output],
  );
  const isError = status !== 'running' && looksLikeError(output);
  const errorSummary = isError ? output.replace(/^Error:\s*/i, '').trim() : '';

  return (
    <BasicTool
      icon={<Globe />}
      trigger={{
        title: 'Web Fetch',
        subtitle: domain || url,
        args: format ? [format] : undefined,
      }}
      rightAccessory={safeUrl ? <ExternalLink /> : undefined}
      onSubtitleClick={safeUrl ? () => openSafeExternalUrl(url) : undefined}
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
            <ExternalLink className="text-muted-foreground/30 group-hover:text-muted-foreground/60 size-3 flex-shrink-0" />
          </a>
          <p className="text-muted-foreground/80 px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {errorSummary}
          </p>
        </div>
      ) : readable ? (
        <div data-scrollable className="max-h-[28rem] overflow-auto">
          <a
            href={safeUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
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
            <ExternalLink className="text-muted-foreground/30 group-hover:text-muted-foreground/60 size-3 flex-shrink-0" />
          </a>

          <p className="text-foreground/80 px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
            {readable.text.slice(0, 4000) || 'No readable text content.'}
          </p>

          <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="border-border/40 text-muted-foreground/60 hover:text-foreground flex w-full items-center gap-1.5 border-t px-3 py-2 text-xs transition-colors"
              >
                <ChevronRight
                  className={cn('size-3 transition-transform', rawOpen && 'rotate-90')}
                />
                {tI18nHardcoded.raw('autoFeaturesSessionToolRenderersJsxTextViewRawHTMLa2f4484f')}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="text-muted-foreground/70 max-h-72 overflow-auto px-3 pb-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
                {output.slice(0, 8000)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : isError ? null : (
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
