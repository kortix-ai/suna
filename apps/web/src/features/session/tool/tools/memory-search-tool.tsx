'use client';

import {
  BasicTool,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { FoldedSection, OutputBlock, ToolField } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { parseMemorySearchOutput } from '@/lib/utils/memory-search-output';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useContext, useMemo } from 'react';

/**
 * The one line a folded hit shows in place of its body.
 *
 * A search hit has no title — `ParsedMemorySearchHit` is id, type, source,
 * confidence, content — so its first line is the only name it has. Sliced, not
 * split: the whole content would otherwise be copied per hit per render, and
 * this runs on the streaming path.
 */
export function hitPreview(content: string): string {
  const trimmed = content.trimStart();
  const end = trimmed.indexOf('\n');
  const line = (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

export function MemorySearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseMemorySearchOutput(output), [output]);
  const query = ((input.query as string) || parsed.query || '').trim();
  const source = ((input.source as string) || '').trim();
  const isStreaming = (status === 'pending' && running) || status === 'running';
  const triggerTitle = parsed.label.toLowerCase().includes('ltm') ? 'LTM Search' : 'Memory Search';
  const resultCount = parsed.hits.length;

  return (
    <BasicTool
      icon={<Search className="size-3.5 shrink-0" />}
      trigger={{
        title: triggerTitle,
        subtitle: query || undefined,
        args:
          status === 'completed'
            ? [`${resultCount} ${resultCount === 1 ? 'result' : 'results'}`]
            : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {parsed.hits.length > 0 ? (
        // A search answers with a LIST, so the list is what has to stay
        // readable. Every hit used to render its full markdown body open, so
        // five hits were five documents stacked end to end and the reader had
        // to scroll past the first to learn that a second existed. Each hit
        // now keeps its identity line — where it came from, its id, how
        // confident the match is, and the opening line of its content — and
        // folds the body behind it.
        <ToolResultCard bodyClassName="space-y-1.5">
          {(query || source) && (
            <FoldedSection label="Request" className="px-2 pt-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {source && <ToolField label="Source" value={source} />}
                {query && <ToolField label="Query" value={query} mono />}
              </div>
            </FoldedSection>
          )}
          {parsed.hits.map((hit) => {
            const sourceLabel =
              hit.source === 'ltm' ? 'LTM' : hit.source === 'obs' ? 'Observation' : 'Memory';
            return (
              <FoldedSection
                key={`${hit.source}-${hit.id}-${hit.type}`}
                className="px-2 py-1.5"
                triggerClassName="text-muted-foreground text-xs tracking-normal normal-case gap-1.5"
                label={
                  <>
                    <span className="shrink-0">
                      {sourceLabel} / {hit.type}
                    </span>
                    <span className="text-muted-foreground/60 shrink-0 font-mono text-xs">
                      #{hit.id}
                    </span>
                    {/* The preview is the hit's only human-readable name —
                        these entries carry no title field, so a fold with the
                        content hidden and nothing in its place would read as
                        "Memory / note #204" and answer nothing. */}
                    <span className="text-foreground/70 min-w-0 flex-1 truncate">
                      {hitPreview(hit.content)}
                    </span>
                    {hit.confidence != null && (
                      <span className="text-muted-foreground/60 shrink-0 text-xs">
                        {Math.round(hit.confidence * 100)}
                        {tHardcodedUi.raw('componentsSessionToolRenderers.line2011JsxTextConf')}
                      </span>
                    )}
                  </>
                }
              >
                <OutputBlock text={hit.content} markdown />
                {hit.files.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {hit.files.map((file) => (
                      <span
                        key={file}
                        className="bg-background text-muted-foreground inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-xs"
                      >
                        {file}
                      </span>
                    ))}
                  </div>
                )}
              </FoldedSection>
            );
          })}
        </ToolResultCard>
      ) : parsed.matched ? (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Searching memory...' : 'No memories found.'} />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="ltm_search" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Searching memory...' : 'No search output yet.'} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('ltm_search', MemorySearchTool);
ToolRegistry.register('ltm-search', MemorySearchTool);
ToolRegistry.register('mem_search', MemorySearchTool);
ToolRegistry.register('mem-search', MemorySearchTool);
ToolRegistry.register('memory_search', MemorySearchTool);
ToolRegistry.register('memory-search', MemorySearchTool);
ToolRegistry.register('oc-mem_search', MemorySearchTool);
ToolRegistry.register('oc-mem-search', MemorySearchTool);
