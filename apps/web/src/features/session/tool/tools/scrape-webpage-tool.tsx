'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { STATUS_TEXT } from '@/components/ui/status';
import {
  BasicTool,
  MD_FLUSH_CLASSES,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  looksLikeHtml,
  resolveScrapeResults,
  wsDomain,
  type ScrapeResult,
} from '@/features/session/tool/shared/web-helpers';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import { DangerTriangleSolid } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

const MAX_CONTENT_CHARS = 8000;

function capContent(content: string): string {
  return content.length > MAX_CONTENT_CHARS
    ? content.slice(0, MAX_CONTENT_CHARS).trimEnd() + '…'
    : content;
}

function getScrapeContent(result: ScrapeResult): { content: string; allowHtml?: boolean } {
  if (!result.success && result.error) return { content: result.error };
  const content = result.content?.trim();
  if (!content) return { content: 'No content extracted.' };
  const capped = capContent(content);
  if (looksLikeHtml(capped)) return { content: capped, allowHtml: true };
  return { content: capped };
}

function ScrapeResultItem({ result }: { result: ScrapeResult }) {
  const url = safeHttpUrl(result.url);
  if (!url) return null;

  const hostname = wsDomain(url);
  const { content, allowHtml } = getScrapeContent(result);

  return (
    <Disclosure variant="outline" className="group rounded-md">
      <DisclosureTrigger className="overflow-hidden rounded-md">
        <div className="group-data-[state=closed]:hover:bg-accent flex w-full cursor-pointer items-center justify-between gap-2 p-3 transition-colors group-data-[state=open]:bg-transparent group-data-[state=open]:hover:bg-transparent">
          <div className="flex items-center gap-2">
            <FaviconAvatar value={url} size="xs" className="shrink-0" />
            <p className="text-foreground min-w-0 truncate text-sm font-medium">
              {result.title || hostname}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!result.success && (
              <DangerTriangleSolid className={cn('size-3 shrink-0', STATUS_TEXT.destructive)} />
            )}
            <p className="text-muted-foreground ml-auto min-w-0 shrink-0 truncate text-xs">
              {hostname}
            </p>
          </div>
        </div>
      </DisclosureTrigger>
      <DisclosureContent className="p-0">
        <DisclosureBody className="px-3 pb-3">
          <div className={cn('text-foreground/80 text-xs', MD_FLUSH_CLASSES)}>
            <UnifiedMarkdown content={content} isStreaming={false} allowHtml={allowHtml} />
          </div>
        </DisclosureBody>
      </DisclosureContent>
    </Disclosure>
  );
}

export function ScrapeWebpageTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tTools = useTranslations('tools');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);

  const rawOutput = part.state.status === 'completed' ? (part.state as any).output : undefined;
  const results = useMemo(
    () => resolveScrapeResults(rawOutput ?? output, input),
    [rawOutput, output, input],
  );
  const totalResults = results.length;

  const triggerBadge =
    status === 'completed' && totalResults > 0
      ? `${totalResults} ${totalResults === 1 ? 'page' : 'pages'}`
      : undefined;

  return (
    <BasicTool
      trigger={
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-foreground text-xs font-medium whitespace-nowrap">
              {tTools('scrapeWebpage')}
            </span>
          </div>
        </>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {results.length > 0 ? (
        <div className="space-y-2">
          {results.map((result, idx) => (
            <ScrapeResultItem key={`${result.url}-${idx}`} result={result} />
          ))}
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('scrape-webpage', ScrapeWebpageTool);
ToolRegistry.register('scrape_webpage', ScrapeWebpageTool);
ToolRegistry.register('scrapewebpage', ScrapeWebpageTool);
