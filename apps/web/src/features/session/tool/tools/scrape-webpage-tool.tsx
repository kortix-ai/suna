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
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  looksLikeHtml,
  resolveScrapeResults,
  wsDomain,
  type ScrapeResult,
} from '@/features/session/tool/shared/web-helpers';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';
import {
  CaretRightIcon,
  WarningIcon as DangerTriangleSolid,
  GlobeIcon,
} from '@phosphor-icons/react';
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

/**
 * One scraped page: the same flat row a search source gets, expandable into the
 * page's own content.
 *
 * The row deliberately carries NO border of its own. It used to be a
 * `Disclosure variant="outline"` — its own `rounded-md border` per result — so
 * putting the list in the shared result card would have nested a rounded border
 * directly inside a rounded border, the one thing the radius rules forbid. The
 * border moved up to the card instead, which is also how `web-search-tool`
 * renders the same shape: one card, flat rows, so a web source looks identical
 * whether it was searched or scraped.
 */
function ScrapeResultItem({ result }: { result: ScrapeResult }) {
  // `getScrapeContent` trims and slices up to 8000 characters of page text and
  // then runs `looksLikeHtml` over the copy. That ran in this body on every
  // render of the row — for every scraped page in the list — even though only
  // the expanded disclosure reads it. `results` is memoised upstream, so each
  // `result` identity is stable and these memos actually hold.
  const url = useMemo(() => safeHttpUrl(result.url), [result.url]);
  const hostname = useMemo(() => (url ? wsDomain(url) : ''), [url]);
  const { content, allowHtml } = useMemo(() => getScrapeContent(result), [result]);

  if (!url) return null;

  return (
    <Disclosure className="group">
      <DisclosureTrigger>
        {/* Row grammar copied from `WebSourceRow`: favicon → title → domain,
				    `rounded-sm` because the row sits inside the card's `p-1` and
				    concentric radius wants inner = outer − padding.
				    The caret is the one deliberate addition. A source row that looks
				    exactly like a search result reads as a link to somewhere else, but
				    this one opens the scraped page IN PLACE — same glyph `InlineFileList`
				    uses to say "this expands rather than navigates". */}
        <div className="hover:bg-muted flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-2 transition-colors duration-150">
          <CaretRightIcon className="text-muted-foreground/60 size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
          <FaviconAvatar value={url} size="xs" className="shrink-0" />
          <span className="text-foreground min-w-0 flex-1 truncate text-sm">
            {result.title || hostname}
          </span>
          {!result.success && (
            <DangerTriangleSolid
              weight="fill"
              className={cn('size-3 shrink-0', STATUS_TEXT.destructive)}
            />
          )}
          <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-sm">
            {hostname}
          </span>
        </div>
      </DisclosureTrigger>
      <DisclosureContent className="p-0">
        <DisclosureBody className="px-2 pb-2">
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
      icon={<GlobeIcon className="size-3.5 shrink-0" />}
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
        // A hairline between siblings, not a gap: once a result is expanded,
        // its page content and the next result's row would otherwise run
        // together with nothing marking where one page ends. Same hairline
        // `bash-tool` puts between a command and its output.
        <ToolResultCard className="[&>*>*+*]:border-border/60 [&>*>*+*]:border-t">
          {(() => {
            const seen = new Map<string, number>();
            return results.map((result) => {
              const n = seen.get(result.url) ?? 0;
              seen.set(result.url, n + 1);
              return (
                <ScrapeResultItem
                  key={n ? `${result.url}#${n}` : result.url}
                  result={result}
                />
              );
            });
          })()}
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('scrape-webpage', ScrapeWebpageTool);
ToolRegistry.register('scrape_webpage', ScrapeWebpageTool);
ToolRegistry.register('scrapewebpage', ScrapeWebpageTool);
