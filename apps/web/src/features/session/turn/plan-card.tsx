'use client';

/**
 * The plan, pinned beneath the user message that owns it.
 *
 * Replaces TodoChip in the composer. Data is live: the `todo.updated` SSE event
 * writes into the same query cache this hook reads.
 */

import { useRuntimeSessionTodo } from '@kortix/sdk/react';
import { CaretDownIcon, ListChecksIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress } from '@/components/ui/progress';
import { Stepper, StepperItem, StepperSeparator, StepperTrigger } from '@/components/ui/stepper';
import { parseTodos, TodoStatusIcon } from '@/features/session/tool/shared/todo-helpers';
import { cn } from '@/lib/utils';

export function planSummary(todos: ReadonlyArray<{ status: string; content: string }>) {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress')?.content;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    current,
  };
}

export function PlanCard({ sessionId }: { sessionId: string }) {
  const { data } = useRuntimeSessionTodo(sessionId);
  const [open, setOpen] = useState(false);

  const todos = parseTodos(data);
  if (todos.length === 0) return null;

  const { done, total, percent, current } = planSummary(todos);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-border/60 bg-card/50 rounded-md border px-3.5 py-2.5">
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 text-left">
          <ListChecksIcon className="text-muted-foreground size-3.5 flex-none" />
          <span className="text-foreground text-xs">Plan</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {done} of {total}
          </span>
          <CaretDownIcon
            className={cn(
              'text-muted-foreground/50 ml-auto size-3.5 flex-none transition-transform',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>

        <Progress
          value={percent}
          className="bg-primary/[0.08] mt-2 h-1"
          indicatorClassName="bg-kortix-green"
        />

        {!open && current && (
          <div className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
            <TodoStatusIcon status="in_progress" />
            <span className="min-w-0 truncate">{current}</span>
          </div>
        )}

        <CollapsibleContent>
          <Stepper orientation="vertical" count={total} className="mt-3 flex w-full flex-col">
            {todos.map((todo, index) => (
              <div key={index} className="flex gap-2.5">
                <StepperItem
                  step={index + 1}
                  completed={todo.status === 'completed'}
                  className="items-center"
                >
                  <StepperTrigger asChild>
                    <span className="mt-px flex shrink-0">
                      <TodoStatusIcon status={todo.status} />
                    </span>
                  </StepperTrigger>
                  <StepperSeparator className="bg-border group-data-[state=completed]/step:bg-kortix-green/40 m-0 my-0.5 group-data-[orientation=vertical]/stepper:min-h-1" />
                </StepperItem>
                <p
                  className={cn(
                    'min-w-0 flex-1 pb-1 text-xs leading-snug text-pretty',
                    todo.status === 'completed'
                      ? 'text-muted-foreground/60 line-through'
                      : 'text-foreground/85',
                  )}
                >
                  {todo.content}
                </p>
              </div>
            ))}
          </Stepper>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
