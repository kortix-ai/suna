'use client';

import React, { useMemo } from 'react';
import { CheckCircle, AlertCircle, Search, Clock, Hash } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';

interface SearchHit {
  id: string;
  title: string;
  updated: string;
  score: string;
  reason: string;
  snippet: string;
}

function parseSearchOutput(output: string): { hits: SearchHit[]; query: string } {
  if (!output || typeof output !== 'string') return { hits: [], query: '' };
  const queryMatch = output.match(/SESSION SEARCH:\s*"([^"]+)"/);
  const query = queryMatch?.[1] ?? '';
  const hits: SearchHit[] = [];
  // Format: ses_xxx | "Title" | Jan 01 12:00 | score=42 | reason
  // Snippet: ...
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(\S+.*?)\s*\|\s*score=(\d+)\s*\|\s*(.+)$/);
    if (m) {
      const snippetLine = lines[i + 1]?.match(/^Snippet:\s*(.+)/);
      hits.push({
        id: m[1], title: m[2], updated: m[3].trim(),
        score: m[4], reason: m[5].trim(),
        snippet: snippetLine?.[1]?.trim() ?? '',
      });
    }
  }
  return { hits, query };
}

export function OcSessionSearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const queryArg = (args.query as string) || (ocState?.input?.query as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const { hits, query } = useMemo(() => parseSearchOutput(output), [output]);
  const displayQuery = queryArg || query;

  if (isStreaming && !toolResult) {
    return <LoadingState title="Searching sessions" subtitle={displayQuery} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Search}
            title="Session Search"
            subtitle={displayQuery ? `"${displayQuery}"` : 'Searching...'}
          />
          {hits.length > 0 && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2">
              <Hash className="h-3 w-3 mr-1 opacity-70" />
              {hits.length}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {hits.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="divide-y divide-border/40">
              {hits.map((h) => (
                <div key={h.id} className="px-4 py-3 hover:bg-muted/20 transition-colors">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-foreground truncate flex-1">
                      {h.title || '(untitled)'}
                    </span>
                    <Badge variant="outline" className="h-4 py-0 text-xs font-normal text-muted-foreground/60">
                      {h.score}
                    </Badge>
                  </div>
                  {h.snippet && (
                    <p className="text-xs text-muted-foreground/70 line-clamp-2 mb-1">{h.snippet}</p>
                  )}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground/50">
                    <span className="font-mono">{h.id}</span>
                    <span className="flex items-center gap-1">
                      <Clock className="size-2.5" />
                      {h.updated}
                    </span>
                    <span className="truncate">{h.reason}</span>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {output.slice(0, 3000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Search failed'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <Search className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No matches</p>
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
          ) : hits.length > 0 ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-muted-foreground" />
              {hits.length} results
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
