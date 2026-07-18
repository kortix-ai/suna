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
import { WebSourceRow } from '@/features/session/tool/shared/web-source-row';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import {
  parseWebSearchOutput,
  type WebSearchQueryResult,
} from '@/features/session/tool/shared/web-helpers';

const VISIBLE_SOURCES = 8;

/** Every source, flat. Multi-query searches get a muted one-line query label
 *  between segments — a caption, not a control. No accordions. */
function FlatSourceList({ queryResults }: { queryResults: WebSearchQueryResult[] }) {
  const [showAll, setShowAll] = useState(false);
  const total = queryResults.reduce((n, q) => n + q.sources.length, 0);
  const hidden = Math.max(0, total - VISIBLE_SOURCES);

  let budget = showAll ? Number.POSITIVE_INFINITY : VISIBLE_SOURCES;

  return (
    <div data-scrollable className="max-h-[400px] space-y-0.5 overflow-auto p-1">
      {queryResults.map((qr, qi) => {
        if (budget <= 0) return null;
        const take = qr.sources.slice(0, budget);
        budget -= take.length;
        return (
          <div key={qi}>
            {queryResults.length > 1 && take.length > 0 && (
              <div className="text-muted-foreground/70 flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs">
                <Search className="size-3 shrink-0" />
                <span className="truncate">{qr.query}</span>
              </div>
            )}
            {take.map((src) => (
              <WebSourceRow key={src.url} url={src.url} title={src.title || src.url} />
            ))}
          </div>
        );
      })}
      {hidden > 0 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center px-2 py-1.5 text-left text-xs transition-colors"
        >
          {hidden} more {hidden === 1 ? 'source' : 'sources'}
        </button>
      )}
    </div>
  );
}

export function WebSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
  const isError = status === 'completed' && isErrorOutput(output);

  const triggerBadge =
    status === 'completed' && !isError && queryResults.length > 0
      ? queryResults.length > 1
        ? `${queryResults.length} queries`
        : totalSources > 0
          ? `${totalSources} ${totalSources === 1 ? 'source' : 'sources'}`
          : undefined
      : undefined;

  return (
    <BasicTool
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line3806JsxTextWebSearch')}
          </span>
          <span className="text-muted-foreground truncate text-xs font-medium">{query}</span>
          {triggerBadge && (
            <span className="text-primary/70 ml-auto flex-shrink-0 text-xs font-medium whitespace-nowrap">
              {triggerBadge}
            </span>
          )}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
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
    </BasicTool>
  );
}
ToolRegistry.register('websearch', WebSearchTool);
ToolRegistry.register('web-search', WebSearchTool);
ToolRegistry.register('web_search', WebSearchTool);
