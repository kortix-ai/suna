'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { useRuntimeSessionTodo } from '@kortix/sdk/react';
import { ChevronDown, ListTodo } from 'lucide-react';

// --- Todo Chip (inline inside the chat input card, same style as sub-session context) ---

export function TodoChip({ sessionId }: { sessionId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: todos } = useRuntimeSessionTodo(sessionId);
  const [expanded, setExpanded] = useState(false);

  if (!Array.isArray(todos) || todos.length === 0) return null;

  const completed = todos.filter((t: any) => t.status === 'completed').length;
  const total = todos.length;
  const inProgress = todos.find((t: any) => t.status === 'in_progress');

  // Sort: in_progress first, then pending, then completed/cancelled
  const sorted = [...todos].sort((a: any, b: any) => {
    const order: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
      cancelled: 3,
    };
    return (order[a.status] ?? 2) - (order[b.status] ?? 2);
  });

  return (
    <div className="bg-muted/50 overflow-hidden rounded-2xl">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="hover:bg-muted/80 flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors"
      >
        <ListTodo className="text-muted-foreground size-3.5 flex-shrink-0" />
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-left text-xs">
          {completed} of {total}
          {tHardcodedUi.raw('componentsSessionSessionChatInput.line1153JsxTextTasksDone')}{' '}
          {inProgress && (
            <span className="text-foreground/80 font-medium"> · {inProgress.content}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground/40 size-3 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* Expanded task list */}
      {expanded && (
        <div className="border-border/30 scrollbar-hide max-h-[160px] space-y-px overflow-y-auto border-t px-3 py-1.5">
          {sorted.map((todo: any, i: number) => {
            const done = todo.status === 'completed';
            const cancelled = todo.status === 'cancelled';
            const active = todo.status === 'in_progress';
            if (cancelled) return null;
            return (
              <div
                key={todo.id || i}
                className={cn('flex items-center gap-2 py-0.5', done && 'opacity-40')}
              >
                <span
                  className={cn(
                    'flex size-3 flex-shrink-0 items-center justify-center rounded-sm border',
                    done
                      ? 'border-border bg-muted'
                      : active
                        ? 'border-foreground/30'
                        : 'border-border',
                  )}
                >
                  {done && (
                    <svg viewBox="0 0 12 12" fill="none" width="8" height="8">
                      <path
                        d="M3 7.17905L5.02703 8.85135L9 3.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="square"
                        className="text-foreground"
                      />
                    </svg>
                  )}
                  {active && <div className="bg-foreground size-1 rounded-full" />}
                </span>
                <span
                  className={cn(
                    'truncate text-xs leading-tight',
                    done && 'text-muted-foreground line-through',
                    !done && 'text-foreground',
                  )}
                >
                  {todo.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
