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
import { OutputBlock, ToolField, ToolSection } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { parseMemorySearchOutput } from '@/lib/utils/memory-search-output';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useContext, useMemo } from 'react';

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
        <ToolResultCard bodyClassName="space-y-1.5">
          {(query || source) && (
            <ToolSection label="Request" className="px-2 pt-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {source && <ToolField label="Source" value={source} />}
                {query && <ToolField label="Query" value={query} mono />}
              </div>
            </ToolSection>
          )}
          {parsed.hits.map((hit) => {
            const sourceLabel =
              hit.source === 'ltm' ? 'LTM' : hit.source === 'obs' ? 'Observation' : 'Memory';
            return (
              <div key={`${hit.source}-${hit.id}-${hit.type}`} className="px-2 py-1.5 text-xs">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">
                    {sourceLabel} / {hit.type}
                  </span>
                  <span className="text-muted-foreground/60 font-mono text-xs">#{hit.id}</span>
                  {hit.confidence != null && (
                    <span className="text-muted-foreground/60 ml-auto text-xs">
                      {Math.round(hit.confidence * 100)}
                      {tHardcodedUi.raw('componentsSessionToolRenderers.line2011JsxTextConf')}
                    </span>
                  )}
                </div>
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
              </div>
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
