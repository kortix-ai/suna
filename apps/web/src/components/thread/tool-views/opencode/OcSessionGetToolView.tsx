'use client';

import React, { useMemo, useState } from 'react';
import {
  CheckCircle,
  AlertCircle,
  BookOpen,
  Clock,
  FileText,
  Minimize2,
  ChevronDown,
  ChevronRight,
  ListTodo,
  MessageSquare,
  GitBranch,
  Hash,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';

// ============================================================================
// Types & Parsing
// ============================================================================

interface SessionGetData {
  title: string;
  id: string;
  created: string;
  updated: string;
  changes: string;
  parent: string | null;
  todos: Array<{ status: 'completed' | 'in_progress' | 'pending'; text: string }>;
  lineage: string | null;
  storagePath: string | null;
  conversationHeader: string;
  conversation: string;
  messageCount: string;
  toolCallCount: string;
  compression: string | null;
  hasConversation: boolean;
}

function parseSessionGetOutput(output: string): SessionGetData | null {
  if (!output || typeof output !== 'string') return null;

  const titleMatch = output.match(/^=== SESSION:\s*(.+?)\s*===$/m);
  const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
  const createdMatch = output.match(/Created:\s*(\S+ \S+)/);
  const updatedMatch = output.match(/Updated:\s*(\S+ \S+)/);
  const changesMatch = output.match(/^Changes:\s*(.+)/m);
  const parentMatch = output.match(/^Parent:\s*(ses_\S+)/m);
  const storageMatch = output.match(/^Storage:\s*(.+)/m);

  // Todos section
  const todosSection = output.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m);
  const todos: SessionGetData['todos'] = [];
  if (todosSection) {
    for (const line of todosSection[1].split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '(none)') continue;
      const statusMatch = trimmed.match(/^\[(\w+)\]\s*(.*)/);
      if (statusMatch) {
        const s = statusMatch[1];
        const status = s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
        todos.push({ status, text: statusMatch[2] });
      } else {
        todos.push({ status: 'pending', text: trimmed });
      }
    }
  }

  // Lineage section
  const lineageMatch = output.match(/=== SESSION LINEAGE ===\n([\s\S]*?)(?=\nStorage:|\n===)/m);
  const lineage = lineageMatch?.[1]?.trim() || null;

  // Conversation
  const convHeaderMatch = output.match(/^(=== CONVERSATION \((.+?)\) ===)$/m);
  const convMeta = convHeaderMatch?.[2] || '';
  const msgCountMatch = convMeta.match(/(\d+) msgs?/);
  const toolCountMatch = convMeta.match(/(\d+) tool calls?/);
  const convStart = convHeaderMatch ? output.indexOf(convHeaderMatch[0]) + convHeaderMatch[0].length : -1;
  const compressMatch = output.match(/^=== COMPRESSION ===\n(.+)/m);
  const convEnd = compressMatch ? output.indexOf('=== COMPRESSION ===') : output.length;
  const conversation = convStart > 0 ? output.slice(convStart, convEnd).trim() : '';

  return {
    title: titleMatch?.[1] ?? 'Unknown Session',
    id: idMatch?.[1] ?? '',
    created: createdMatch?.[1] ?? '',
    updated: updatedMatch?.[1] ?? '',
    changes: changesMatch?.[1] ?? '',
    parent: parentMatch?.[1] ?? null,
    todos,
    lineage,
    storagePath: storageMatch?.[1]?.trim() ?? null,
    conversationHeader: convHeaderMatch?.[1] ?? '',
    conversation,
    messageCount: msgCountMatch?.[1] ?? '0',
    toolCallCount: toolCountMatch?.[1] ?? '0',
    compression: compressMatch?.[1]?.trim() ?? null,
    hasConversation: !!convHeaderMatch,
  };
}

// ============================================================================
// Sub-components
// ============================================================================

function MetaItem({ icon: Icon, label, value, mono }: { icon: any; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
      <Icon className="size-3 flex-shrink-0 opacity-50" />
      <span className="opacity-60">{label}</span>
      <span className={cn(mono && 'font-mono text-[11px]')}>{value}</span>
    </div>
  );
}

function CollapsibleSection({
  title,
  icon: Icon,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: any;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors text-left"
      >
        {open ? <ChevronDown className="size-3 text-muted-foreground/50" /> : <ChevronRight className="size-3 text-muted-foreground/50" />}
        <Icon className="size-3.5 text-muted-foreground/70" />
        <span className="text-xs font-medium">{title}</span>
        {badge && (
          <Badge variant="outline" className="h-4 py-0 text-[0.5625rem] ml-auto">
            {badge}
          </Badge>
        )}
      </button>
      {open && (
        <div className="border-t border-border/30">
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function OcSessionGetToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const sessionId = (args.session_id as string) || (ocState?.input?.session_id as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const data = useMemo(() => parseSessionGetOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Retrieving session" subtitle={sessionId} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={BookOpen}
            title={data?.title ?? 'Session'}
            subtitle={sessionId}
          />
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
            {data?.compression && (
              <Badge variant="outline" className="h-5 py-0 text-[10px] bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300">
                <Minimize2 className="h-3 w-3 mr-0.5" />
                Compressed
              </Badge>
            )}
            {data?.hasConversation && (
              <Badge variant="outline" className="h-5 py-0 text-[10px]">
                <MessageSquare className="h-3 w-3 mr-0.5" />
                {data.messageCount} msgs
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {data ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-3">
              {/* Metadata */}
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                <MetaItem icon={Hash} label="ID" value={data.id} mono />
                <MetaItem icon={Clock} label="Created" value={data.created} />
                {data.updated && data.updated !== data.created && (
                  <MetaItem icon={Clock} label="Updated" value={data.updated} />
                )}
                <MetaItem icon={FileText} label="Changes" value={data.changes} />
                {data.parent && (
                  <MetaItem icon={GitBranch} label="Parent" value={data.parent} mono />
                )}
              </div>

              {/* Todos */}
              {data.todos.length > 0 && (
                <CollapsibleSection title="Todos" icon={ListTodo} badge={String(data.todos.length)} defaultOpen>
                  <div className="px-3 py-2 space-y-1.5">
                    {data.todos.map((todo, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <div className={cn(
                          'w-3.5 h-3.5 rounded border flex-shrink-0 mt-[1px] flex items-center justify-center',
                          todo.status === 'completed' && 'bg-emerald-100 dark:bg-emerald-950/40 border-emerald-400 dark:border-emerald-600',
                          todo.status === 'in_progress' && 'border-blue-400 dark:border-blue-500',
                          todo.status === 'pending' && 'border-border',
                        )}>
                          {todo.status === 'completed' && (
                            <CheckCircle className="size-2.5 text-emerald-600 dark:text-emerald-400" />
                          )}
                          {todo.status === 'in_progress' && (
                            <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                          )}
                        </div>
                        <span className={cn(
                          'leading-snug',
                          todo.status === 'completed' && 'line-through text-muted-foreground/60',
                          todo.status === 'in_progress' && 'font-medium',
                        )}>
                          {todo.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              )}

              {/* Lineage */}
              {data.lineage && (
                <CollapsibleSection title="Lineage" icon={GitBranch}>
                  <div className="px-3 py-2 font-mono text-[11px] text-muted-foreground/70 whitespace-pre-wrap leading-relaxed">
                    {data.lineage}
                  </div>
                </CollapsibleSection>
              )}

              {/* Conversation */}
              {data.conversation && (
                <CollapsibleSection
                  title="Conversation"
                  icon={MessageSquare}
                  badge={`${data.messageCount} msgs · ${data.toolCallCount} tool calls`}
                >
                  <div className="p-3">
                    <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                      <UnifiedMarkdown content={data.conversation} />
                    </div>
                  </div>
                </CollapsibleSection>
              )}

              {/* Compression stats */}
              {data.compression && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/50 px-1">
                  <Minimize2 className="size-3" />
                  <span>{data.compression}</span>
                </div>
              )}

              {/* No conversation */}
              {!data.conversation && !data.todos.length && (
                <div className="text-center py-6">
                  <p className="text-xs text-muted-foreground/50 italic">No messages in this session</p>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : output && !isError ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {output.slice(0, 5000)}
            </div>
          </ScrollArea>
        ) : isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || 'Failed to retrieve session'}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <BookOpen className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No session data</p>
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
          ) : data ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              Loaded
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
