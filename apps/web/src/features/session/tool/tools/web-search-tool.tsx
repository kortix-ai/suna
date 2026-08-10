'use client';

import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { WebSourceRow } from '@/features/session/tool/shared/web-source-row';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { humanizeSearchQuery } from '@/features/session/tool/shared/search-query';
import {
  parseWebSearchOutput,
  type WebSearchQueryResult,
} from '@/features/session/tool/shared/web-helpers';

/**
 * Every source, flat, inside one bordered card.
 *
 * The card is the point: a run of sources reads as a single object the search
 * returned, not as loose rows leaking into the step list around it. It borrows
 * the popover surface because that is what this is — a panel of results
 * hanging off the row above — even though it is rendered inline rather than
 * floated, so expanding never moves the reader out of the conversation.
 *
 * Elevation is the hairline alone. The tool-view grammar forbids shadows
 * (asserted in conformance.test.ts), and `--popover` already lifts off
 * `--background` in dark mode; in light both are pure white, so the border is
 * doing exactly the work it does in the reference.
 *
 * Long lists scroll inside the card (`max-h` + overflow). Multi-query searches
 * get a muted one-line query caption between segments — a caption, not a
 * control. No accordions, no "show more" button.
 */
function FlatSourceList({ queryResults }: { queryResults: WebSearchQueryResult[] }) {
  return (
    <ToolResultCard>
      {queryResults.map((qr, qi) => (
        <div key={qi}>
          {queryResults.length > 1 && qr.sources.length > 0 && (
            <div className="text-muted-foreground/70 flex items-center gap-2 px-2 pt-2 pb-1 text-xs">
              <Search className="size-3 shrink-0" />
              <span className="truncate">{humanizeSearchQuery(qr.query)}</span>
            </div>
          )}
          {qr.sources.map((src) => (
            <WebSourceRow key={src.url} url={src.url} title={src.title || src.url} />
          ))}
        </div>
      ))}
    </ToolResultCard>
  );
}

export function WebSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  const rawOutput = part.state.status === 'completed' ? (part.state as any).output : undefined;
  const queryResults = useMemo(
    () => parseWebSearchOutput(rawOutput ?? output),
    [rawOutput, output],
  );
  const totalSources = useMemo(
    () => queryResults.reduce((n, q) => n + q.sources.length, 0),
    [queryResults],
  );
  // `isErrorOutput` runs a second full `trim()` + `JSON.parse` over the same
  // payload `parseWebSearchOutput` already parsed above — unmemoised, that was a
  // whole extra parse of the search result set on every render.
  const isError = useMemo(
    () => status === 'completed' && isErrorOutput(output),
    [status, output],
  );

  // A non-technical reader doesn't need to be told this is "a web search" —
  // the magnifying-glass icon already says that. The row is just what was
  // searched for, so it reads the same way a search-results page would.
  //
  // Which is exactly why the query cannot go through raw: models write engine
  // syntax (`site:daytona.io Daytona sandboxes`), and a search-results page
  // never shows you your own operators back. See `humanizeSearchQuery`.
  const triggerLabel =
    queryResults.length === 1
      ? humanizeSearchQuery(queryResults[0].query) || humanizeSearchQuery(query)
      : queryResults.length > 1
        ? `${queryResults.length} searches`
        : humanizeSearchQuery(query);

  // "results", never "sources"/"queries" — one word, used consistently
  // whether it's one query or several.
  const triggerBadge =
    status === 'completed' && !isError && totalSources > 0
      ? `${totalSources} ${totalSources === 1 ? 'result' : 'results'}`
      : undefined;

  return (
    <BasicTool
      icon={<Search className="size-3.5 shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground min-w-0 truncate text-sm">{triggerLabel}</span>
          {triggerBadge && (
            <span className="text-muted-foreground/70 ml-auto shrink-0 text-sm whitespace-nowrap">
              {triggerBadge}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <>
        {isError ? (
          <ToolOutputFallback output={output} toolName="web_search" />
        ) : queryResults.length > 0 ? (
          <FlatSourceList queryResults={queryResults} />
        ) : output ? (
          <ToolOutputFallback
            output={output}
            isStreaming={status === 'running'}
            toolName="web_search"
          />
        ) : null}
      </>
    </BasicTool>
  );
}
ToolRegistry.register('websearch', WebSearchTool);
ToolRegistry.register('web-search', WebSearchTool);
ToolRegistry.register('web_search', WebSearchTool);
