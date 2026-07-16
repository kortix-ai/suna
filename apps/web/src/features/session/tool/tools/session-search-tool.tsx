'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  ToolEmptyState,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import {
  Search,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


export function SessionSearchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const query = (input.query as string) || '';

  const hits = useMemo(() => {
    if (!output) return [];
    const results: Array<{
      id: string;
      title: string;
      updated: string;
      score: string;
      snippet: string;
    }> = [];
    const lines = output.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(\S+.*?)\s*\|\s*score=(\d+)/);
      if (m) {
        const snippetLine = lines[i + 1]?.match(/^Snippet:\s*(.+)/);
        results.push({
          id: m[1],
          title: m[2],
          updated: m[3].trim(),
          score: m[4],
          snippet: snippetLine?.[1]?.trim() || '',
        });
      }
    }
    return results;
  }, [output]);

  const noResults = status === 'completed' && hits.length === 0 && !isErrorOutput(output);

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Session Search',
        subtitle: query ? `"${query}"` : '',
        args: hits.length > 0 ? [`${hits.length} results`] : noResults ? ['no matches'] : [],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {hits.length > 0 ? (
        <div data-scrollable className="divide-border/20 max-h-72 divide-y overflow-auto">
          {hits.map((h) => (
            <div key={h.id} className="hover:bg-muted/20 px-3 py-2 transition-colors">
              <div className="mb-0.5 flex items-center gap-2">
                <span className="text-foreground flex-1 truncate text-xs font-medium">
                  {h.title || '(untitled)'}
                </span>
                <span className="text-muted-foreground/40 bg-muted/40 flex-shrink-0 rounded px-1 font-mono text-xs">
                  {h.score}
                </span>
              </div>
              {h.snippet && (
                <p className="text-muted-foreground/60 line-clamp-1 text-xs">{h.snippet}</p>
              )}
              <div className="text-muted-foreground/40 mt-0.5 flex items-center gap-2 text-xs">
                <span className="font-mono">{h.id.slice(-12)}</span>
                <span>{h.updated}</span>
              </div>
            </div>
          ))}
        </div>
      ) : noResults ? (
        <ToolEmptyState message={`No sessions matched "${query}"`} />
      ) : output ? (
        <ToolOutputFallback output={output} toolName="session_search" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_search', SessionSearchTool);
ToolRegistry.register('session-search', SessionSearchTool);
ToolRegistry.register('oc-session_search', SessionSearchTool);
ToolRegistry.register('oc-session-search', SessionSearchTool);

