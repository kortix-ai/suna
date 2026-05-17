'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle,
  AlertCircle,
  List,
  Clock,
  FileText,
  ChevronRight,
  ChevronDown,
  Hash,
  Search,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';

// ============================================================================
// Types & Parsing
// ============================================================================

interface SessionEntry {
  id: string;
  title: string;
  created: string;
  updated: string;
  changes: string;
  parent: string | null;
}

function parseSessionListOutput(output: string): { sessions: SessionEntry[]; total: number; shown: number } {
  if (!output || typeof output !== 'string') return { sessions: [], total: 0, shown: 0 };

  // Header: === SESSIONS (20/45) ===
  const headerMatch = output.match(/SESSIONS\s*\((\d+)\/(\d+)\)/);
  const shown = headerMatch ? parseInt(headerMatch[1], 10) : 0;
  const total = headerMatch ? parseInt(headerMatch[2], 10) : 0;

  const sessions: SessionEntry[] = [];
  // Lines:   ses_xxx | "Title" | Jan 01 12:00 → Jan 01 13:00 | +5 -2 ~3 [child of ses_yyy]
  const lineRe = /^\s{2}(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(.+?)\s*→\s*(.+?)\s*\|\s*(.+?)(?:\s*\[child of\s*(ses_\S+)\])?$/gm;

  let m;
  while ((m = lineRe.exec(output)) !== null) {
    sessions.push({
      id: m[1],
      title: m[2],
      created: m[3].trim(),
      updated: m[4].trim(),
      changes: m[5].trim(),
      parent: m[6] || null,
    });
  }

  return { sessions, total, shown };
}

// ============================================================================
// Component
// ============================================================================

export function OcSessionListToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const searchQuery = (args.search as string) || (ocState?.input?.search as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const { sessions, total, shown } = useMemo(() => parseSessionListOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Loading sessions" subtitle={searchQuery || 'Fetching list...'} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={List}
            title="Session List"
            subtitle={searchQuery ? `"${searchQuery}"` : 'All sessions'}
          />
          {sessions.length > 0 && (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted flex-shrink-0 ml-2">
              <Hash className="h-3 w-3 mr-1 opacity-70" />
              {shown}/{total}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {sessions.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="divide-y divide-border/40">
              {sessions.map((s) => (
                <div key={s.id} className="px-4 py-3 hover:bg-muted/20 transition-colors">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-foreground truncate flex-1">
                      {s.title || '(untitled)'}
                    </span>
                    {s.parent && (
                      <Badge variant="outline" className="h-4 py-0 text-[0.5625rem] font-normal text-muted-foreground/60">
                        fork
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60">
                    <span className="font-mono truncate">{s.id}</span>
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" />
                      {s.updated}
                    </span>
                    <span className="flex items-center gap-1">
                      <FileText className="size-3" />
                      {s.changes}
                    </span>
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
            <p className="text-sm">{output || 'Failed to list sessions'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <List className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No sessions found</p>
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
          ) : sessions.length > 0 ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-muted-foreground" />
              {shown} sessions
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
