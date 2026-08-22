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
import { ListChecksIcon as ListTodo } from '@phosphor-icons/react';
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
  // Two more passes over the list per render — one of them allocating a throwaway
  // array — on the one tool row that is on screen for the whole of a long turn.
  // `todos` is a stable identity now, so keying on it is enough.
  const done = useMemo(() => todos.filter((t) => t.status === 'completed').length, [todos]);
  const active = useMemo(() => todos.find((t) => t.status === 'in_progress'), [todos]);
  const pct = total ? Math.round((done / total) * 100) : 0;

  // Todos carry no id — key on content, disambiguating a repeated line with an
  // occurrence counter so React state follows the row, not its position.
  const keyedTodos = useMemo(() => {
    const seen = new Map<string, number>();
    return todos.map((todo) => {
      const n = seen.get(todo.content) ?? 0;
      seen.set(todo.content, n + 1);
      return { todo, key: n === 0 ? todo.content : `${todo.content}#${n}` };
    });
  }, [todos]);

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
            {keyedTodos.map(({ todo, key }, i) => (
              <div key={key} className="flex gap-2.5">
                <StepperItem
                  step={i + 1}
                  completed={todo.status === 'completed'}
                  className="items-center"
                >
                  <StepperTrigger asChild>
                    <span className="mt-px flex shrink-0 items-center justify-center">
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
