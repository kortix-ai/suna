'use client';

import React, { useMemo, useState } from 'react';
import { BookOpen, CheckCircle, AlertCircle, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import { STATUS_TEXT, DiffStat } from '@/components/ui/status';

const MODE_LABELS: Record<string, string> = {
  summary: 'Summary',
  messages: 'Messages',
  diffs: 'File Changes',
  todo: 'Todo List',
};

function extractContent(output: string): string {
  // Strip <session_context ...> wrapper tags if present
  const match = output.match(/<session_context[^>]*>([\s\S]*)<\/session_context>/);
  return match ? match[1].trim() : output;
}

export function OcSessionContextToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const metadata = ocState?.metadata || {};

  const mode = (metadata.mode || args.mode || 'summary') as string;
  const sessionTitle = (metadata.sessionTitle || '') as string;
  const sessionID = (metadata.sessionID || args.sessionID || '') as string;
  const modeLabel = MODE_LABELS[mode] || mode;

  const output = useMemo(() => {
    if (ocState?.output) return extractContent(ocState.output);
    if (toolResult?.output) return extractContent(toolResult.output);
    return '';
  }, [ocState?.output, toolResult?.output]);

  const isError = toolResult?.success === false || !!toolResult?.error;

  if (isStreaming && !toolResult) {
    return <LoadingState title={`Fetching ${modeLabel.toLowerCase()}...`} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={BookOpen}
            title={sessionTitle || 'Session Context'}
            subtitle={modeLabel}
          />
          <span className="inline-flex items-center text-xs text-muted-foreground/80 tracking-tight flex-shrink-0">
            {modeLabel}
          </span>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-4">
            {mode === 'todo' ? (
              <TodoContent output={output} />
            ) : mode === 'messages' ? (
              <MessagesContent output={output} />
            ) : mode === 'diffs' ? (
              <DiffsContent output={output} />
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <UnifiedMarkdown content={output} />
              </div>
            )}
          </div>
        </ScrollArea>
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
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className={cn('h-3 w-3', STATUS_TEXT.success)} />
              Loaded
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

function TodoContent({ output }: { output: string }) {
  const lines = output.split('\n').filter((l) => l.startsWith('- '));
  if (lines.length === 0) {
    return <div className="text-sm text-muted-foreground">{output || 'No todos found.'}</div>;
  }
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const isCompleted = line.includes('[x]');
        const isInProgress = line.includes('[~]');
        const isCancelled = line.includes('[-]');
        const content = line.replace(/^- \[.\] /, '');
        return (
          <label key={i} className="flex items-start gap-2.5 py-1">
            <input type="checkbox" checked={isCompleted} readOnly className="mt-0.5 rounded border-border" />
            <span
              className={cn(
                'text-sm leading-relaxed',
                isCompleted && 'line-through text-muted-foreground',
                isInProgress && 'text-foreground font-medium',
                isCancelled && 'line-through text-muted-foreground/60',
              )}
            >
              {content}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function MessagesContent({ output }: { output: string }) {
  const messages = useMemo(() => {
    const lines = output.split('\n');
    const msgs: { role: string; content: string }[] = [];
    let current: { role: string; content: string } | null = null;

    for (const line of lines) {
      const match = line.match(/^\[(user|assistant)\](?:\s*\(.*?\))?:\s*(.*)/);
      if (match) {
        if (current) msgs.push(current);
        current = { role: match[1], content: match[2] };
      } else if (current && line.trim()) {
        current.content += '\n' + line;
      }
    }
    if (current) msgs.push(current);
    return msgs;
  }, [output]);

  if (messages.length === 0) {
    return <div className="text-sm text-muted-foreground">{output || 'No messages found.'}</div>;
  }

  return (
    <div className="space-y-3">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={cn(
            'rounded-2xl px-3 py-2 text-sm',
            msg.role === 'user'
              ? 'bg-muted/50 border border-border/50'
              : 'bg-card border border-border/30',
          )}
        >
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">
            {msg.role}
          </div>
          <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
            {msg.content.slice(0, 1000)}
            {msg.content.length > 1000 && <span className="text-muted-foreground">...</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffsContent({ output }: { output: string }) {
  // Parse the markdown-formatted diff output
  const files = useMemo(() => {
    const sections = output.split(/^## /m).filter(Boolean);
    return sections.map((section) => {
      const lines = section.split('\n');
      const header = lines[0] || '';
      const rest = lines.slice(1).join('\n').trim();
      return { header, content: rest };
    });
  }, [output]);

  if (files.length === 0) {
    return <div className="text-sm text-muted-foreground">{output || 'No file changes.'}</div>;
  }

  return (
    <div className="space-y-2">
      {files.map((file, i) => (
        <DiffFile key={i} header={file.header} content={file.content} />
      ))}
    </div>
  );
}

function DiffFile({ header, content }: { header: string; content: string }) {
  const [open, setOpen] = useState(false);

  // Parse header like "path/to/file.ts (modified) +10 -5"
  const match = header.match(/^(.+?)\s*\((\w+)\)\s*\+(\d+)\s*-(\d+)/);
  const path = match?.[1]?.trim() || header;
  const status = match?.[2] || 'modified';
  const additions = match?.[3] || '0';
  const deletions = match?.[4] || '0';

  return (
    <div className="border border-border/50 rounded-2xl overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span className="text-xs font-mono truncate flex-1">{path}</span>
        <Badge variant="outline" className="h-4 py-0 text-xs shrink-0">
          {status}
        </Badge>
        <DiffStat
          additions={parseInt(additions, 10) || 0}
          deletions={parseInt(deletions, 10) || 0}
          className="text-xs"
        />
      </button>
      {open && content && (
        <div className="border-t border-border/30 bg-muted/10 p-2 overflow-x-auto">
          <pre className="text-xs font-mono whitespace-pre leading-relaxed">{content}</pre>
        </div>
      )}
    </div>
  );
}
