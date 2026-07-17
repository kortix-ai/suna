'use client';

import { Progress } from '@/components/ui/progress';
import { Stepper, StepperItem, StepperSeparator, StepperTrigger } from '@/components/ui/stepper';
import {
  BasicTool,
  partInput,
  partMetadata,
  partStreamingInput,
  ToolEmptyState,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { parseTodos, TodoStatusIcon } from '@/features/session/tool/shared/todo-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { ListTodo } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

export function TodoWriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);

  const todos = useMemo(() => {
    const fromInput = parseTodos(input.todos);
    if (fromInput.length) return fromInput;
    const fromMeta = parseTodos(metadata.todos);
    if (fromMeta.length) return fromMeta;
    return parseTodos(streamingInput.todos);
  }, [input.todos, metadata.todos, streamingInput.todos]);

  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  const pct = total ? Math.round((done / total) * 100) : 0;

  const subtitle = active ? active.content : total ? `${done} of ${total} done` : undefined;

  return (
    <BasicTool
      icon={<ListTodo className="size-3.5 shrink-0" />}
      trigger={{ title: 'Todos', subtitle }}
      badge={
        total ? (
          <span className="tabular-nums">
            {done}/{total}
          </span>
        ) : undefined
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {total > 0 ? (
        <div data-scrollable className="overflow-auto">
          <Progress
            value={pct}
            className="bg-primary/[0.08] mb-3 h-1"
            indicatorClassName="bg-kortix-green"
          />
          <Stepper orientation="vertical" count={total} className="flex w-full flex-col">
            {todos.map((todo, i) => (
              <div key={i} className="flex gap-2.5">
                <StepperItem
                  step={i + 1}
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
                    'min-w-0 flex-1 text-xs leading-snug text-pretty',
                    i + 1 < total && 'pb-3',
                    todo.status === 'completed' && 'text-muted-foreground/60 line-through',
                    todo.status === 'in_progress' && 'text-foreground font-medium',
                    todo.status === 'pending' && 'text-muted-foreground',
                    todo.status === 'cancelled' && 'text-muted-foreground/40 line-through',
                  )}
                >
                  {todo.content}
                </p>
              </div>
            ))}
          </Stepper>
        </div>
      ) : (
        <ToolEmptyState
          message={tI18nHardcoded.raw(
            'autoFeaturesSessionToolRenderersJsxAttrMessageNoTasksYet198712c5',
          )}
        />
      )}
    </BasicTool>
  );
}
ToolRegistry.register('todowrite', TodoWriteTool);
ToolRegistry.register('todo_write', TodoWriteTool);
ToolRegistry.register('todo-write', TodoWriteTool);
