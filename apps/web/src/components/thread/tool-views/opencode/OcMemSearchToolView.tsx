'use client';

import React, { useMemo } from 'react';
import {
  Search,
  CheckCircle,
  AlertCircle,
  Brain,
  Database,
  Eye,
  BookOpen,
  Wrench,
  Hash,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';
import { parseMemorySearchOutput } from '@/lib/utils/memory-search-output';

// ============================================================================
// Types & Parsing
// ============================================================================

const TYPE_ICONS: Record<string, typeof Brain> = {
  episodic: BookOpen,
  semantic: Brain,
  procedural: Wrench,
  file_read: Eye,
  file_edit: Eye,
  code_search: Search,
  command: Wrench,
  web: Search,
  session: Database,
};

const SOURCE_COLORS = {
  ltm: 'bg-foreground/[0.04] text-foreground/85 border-border/50',
  obs: 'bg-foreground/[0.04] text-foreground/85 border-border/50',
};

// ============================================================================
// Component
// ============================================================================

export function OcMemSearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const source = (args.source as string) || 'both';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const parsed = useMemo(() => parseMemorySearchOutput(output), [output]);
  const query = ((args.query as string) || (ocState?.input?.query as string) || parsed.query || '').trim();
  const sourceHint = source !== 'both' ? source : parsed.label.toLowerCase().includes('ltm') ? 'ltm' : undefined;
  const title = parsed.label.toLowerCase().includes('ltm') ? 'LTM Search' : 'Memory Search';

  if (isStreaming && !toolResult) {
    return <LoadingState title="Searching memory" subtitle={query} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Brain} title={title} subtitle={query} />
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
            {sourceHint && (
              <Badge variant="outline" className="h-5 py-0 text-xs">
                {sourceHint}
              </Badge>
            )}
            {parsed.hits.length > 0 && (
              <Badge variant="outline" className="h-6 py-0.5 bg-muted">
                <Hash className="h-3 w-3 mr-1 opacity-70" />
                {parsed.hits.length} {parsed.hits.length === 1 ? 'result' : 'results'}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {parsed.hits.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 space-y-2">
              {parsed.hits.map((hit) => {
                const Icon = TYPE_ICONS[hit.type] || Database;
                const sourceClass = hit.source === 'unknown' ? 'bg-muted text-muted-foreground border-border/60' : SOURCE_COLORS[hit.source];
                const sourceLabel = hit.source === 'ltm' ? 'LTM' : hit.source === 'obs' ? 'Observation' : 'Memory';
                return (
                  <div
                    key={`${hit.source}-${hit.id}`}
                    className="rounded-2xl border border-border/60 bg-card p-3"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <Icon className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
                      <Badge
                        variant="outline"
                        className={cn('h-5 py-0 text-xs font-normal', sourceClass)}
                      >
                        {sourceLabel} / {hit.type}
                      </Badge>
                      <span className="text-xs text-muted-foreground/50 font-mono">#{hit.id}</span>
                      {hit.confidence != null && (
                        <span className="text-xs text-muted-foreground/50 ml-auto">
                          {Math.round(hit.confidence * 100)}% conf
                        </span>
                      )}
                    </div>
                    <p className="text-sm leading-relaxed text-foreground/85">
                      {hit.content}
                    </p>
                    {hit.files.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {hit.files.map((f) => (
                          <span key={f} className="text-xs font-mono text-muted-foreground/50 bg-muted/50 px-1.5 py-0.5 rounded">
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        ) : parsed.matched && !isError ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Brain className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No memories found</p>
          </div>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {output.slice(0, 3000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Memory search failed'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Brain className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No memories found</p>
          </div>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : parsed.hits.length > 0 ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-muted-foreground" />
              {parsed.hits.length} {parsed.hits.length === 1 ? 'memory' : 'memories'}
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
