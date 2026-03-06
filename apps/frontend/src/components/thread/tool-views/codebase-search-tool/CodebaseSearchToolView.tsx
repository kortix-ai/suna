'use client';

import React from 'react';
import { Search, FileCode } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewHeader } from '../shared/ToolViewHeader';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { getToolTitle } from '../utils';

interface CodeResult {
  file: string;
  ranges: string;
  content: string;
}

export function CodebaseSearchToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  if (!toolCall) return null;

  const query = toolCall.arguments?.query;
  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  let parsedOutput: Record<string, any> | null = null;
  try {
    parsedOutput = typeof toolResult?.output === 'string'
      ? JSON.parse(toolResult.output)
      : toolResult?.output;
  } catch {
    parsedOutput = null;
  }
  const results: CodeResult[] = (parsedOutput?.results as CodeResult[]) || [];

  const isKeyError = !isSuccess && typeof toolResult?.output === 'string' && toolResult.output.includes('API key');

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <ToolViewHeader icon={Search} title={toolTitle} />

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Search}
            title="Searching codebase"
            filePath={query}
            progressText="Analyzing code..."
          />
        ) : isKeyError ? (
          <div className="p-4 text-sm">
            <p className="text-destructive mb-2">Morph API key required</p>
            <p className="text-muted-foreground">
              Add your Morph API key in{' '}
              <a href="/settings/credentials" className="underline">Settings &gt; API Keys</a>
              {' '}to use codebase search.
            </p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <div className="w-16 h-16 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-4">
              <Search className="h-8 w-8 text-zinc-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Results Found
            </h3>
            {query && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center">
                No relevant code found for &quot;{query}&quot;
              </p>
            )}
          </div>
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="divide-y">
              {results.map((r, i) => (
                <div key={i} className="p-3">
                  <div className="flex items-center gap-2 mb-2 font-mono text-sm">
                    <FileCode className="h-4 w-4 text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{r.file}</span>
                    <span className="text-zinc-500 dark:text-zinc-400">({r.ranges})</span>
                  </div>
                  <pre className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 overflow-x-auto whitespace-pre font-mono text-zinc-700 dark:text-zinc-300">
                    {r.content}
                  </pre>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && results.length > 0 && (
          <Badge variant="outline" className="h-6 py-0.5">
            <FileCode className="h-3 w-3" />
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </Badge>
        )}
      </ToolViewFooter>
    </Card>
  );
}
