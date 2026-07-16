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
import type { ToolProps } from '@/features/session/tool/shared/types';
import { parseMemorySearchOutput } from '@/lib/utils/memory-search-output';
import { Search } from 'lucide-react';
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
      icon={<Search className="size-3.5 flex-shrink-0" />}
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
      <div className="space-y-2.5 p-2.5">
        {(query || source) && (
          <ToolSection label="Request">
            <div className="flex flex-wrap items-center gap-1.5">
              {source && <ToolField label="Source" value={source} />}
              {query && <ToolField label="Query" value={query} mono />}
            </div>
          </ToolSection>
        )}

        {parsed.hits.length > 0 ? (
          <div className="space-y-1.5">
            {parsed.hits.map((hit) => {
              const sourceLabel =
                hit.source === 'ltm' ? 'LTM' : hit.source === 'obs' ? 'Observation' : 'Memory';
              return (
                // Card wrapper, not OutputBlock — holds composed fields, not output text.
                <div
                  key={`${hit.source}-${hit.id}-${hit.type}`}
                  className="bg-muted/20 rounded-sm px-3 py-2 text-xs"
                >
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
          </div>
        ) : parsed.matched ? (
          <ToolEmptyState message={isStreaming ? 'Searching memory...' : 'No memories found.'} />
        ) : output ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="ltm_search" />
        ) : (
          <ToolEmptyState message={isStreaming ? 'Searching memory...' : 'No search output yet.'} />
        )}
      </div>
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
