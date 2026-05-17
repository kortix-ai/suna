'use client';

import React from 'react';
import { CheckSquare, AlertCircle, Check } from 'lucide-react';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { formatTimestamp } from '../utils';
import { cn } from '@/lib/utils';
import {
  Counter,
  Status,
  StatusDot,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewShell,
} from '../shared/primitives';

interface TodoItem {
  id?: string;
  content: string;
  status: string;
  priority?: string;
}

export function OcTodoToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const metadata = ocState?.metadata || {};
  const todos: TodoItem[] = Array.isArray(metadata?.todos)
    ? metadata.todos
    : Array.isArray(args?.todos)
      ? (args.todos as TodoItem[])
      : [];

  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const total = todos.length;
  const isError = toolResult?.success === false || !!toolResult?.error;

  if (isStreaming && !toolResult) {
    return <LoadingState title="Updating tasks" />;
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={CheckSquare}
        title="Tasks"
        actions={
          <>
            {total > 0 && (
              <span className="text-[11px] text-muted-foreground/70 tracking-tight tabular-nums">
                <span className="text-foreground/90 font-medium">{completed}</span>
                <span className="text-muted-foreground/50">/{total}</span>
              </span>
            )}
            {inProgress > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80 tracking-tight">
                <StatusDot tone="active" />
                {inProgress} active
              </span>
            )}
          </>
        }
      />

      <ToolViewBody padded={false}>
        {total === 0 ? (
          <div className="px-4 py-6 text-[12px] text-muted-foreground/70 tracking-tight text-center">
            No tasks.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {todos.map((todo, i) => (
              <li
                key={todo.id || i}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <Checkbox status={todo.status} />
                <span
                  className={cn(
                    'flex-1 min-w-0 text-[13px] leading-snug truncate tracking-tight',
                    todo.status === 'completed' && 'line-through text-muted-foreground/50',
                    todo.status === 'in_progress' && 'text-foreground font-medium',
                    todo.status === 'pending' && 'text-foreground/85',
                  )}
                >
                  {todo.content}
                </span>
                {todo.priority && (
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium flex-shrink-0">
                    {todo.priority}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </ToolViewBody>

      <ToolViewFoot timestamp={ts}>
        {isError ? (
          <Status tone="error">
            <AlertCircle className="w-3 h-3" />
            Failed
          </Status>
        ) : (
          <Status tone="success">Updated</Status>
        )}
      </ToolViewFoot>
    </ToolViewShell>
  );
}

function Checkbox({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <span className="w-3.5 h-3.5 rounded-[3px] bg-foreground/[0.08] border border-border/60 flex items-center justify-center flex-shrink-0">
        <Check className="w-2.5 h-2.5 text-foreground/80" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="w-3.5 h-3.5 rounded-[3px] border border-foreground/50 flex items-center justify-center flex-shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-foreground animate-pulse" />
      </span>
    );
  }
  return (
    <span className="w-3.5 h-3.5 rounded-[3px] border border-border/60 flex-shrink-0" />
  );
}
