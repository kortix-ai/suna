'use client';

import { Progress } from '../../../primitives/progress';
import { Stepper, StepperItem, StepperSeparator, StepperTrigger } from '../../../primitives/stepper';
import {
  BasicTool,
  partInput,
  partMetadata,
  partStreamingInput,
  ToolEmptyState,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { parseTodos, TodoStatusIcon } from '../shared/todo-helpers';
import type { ToolProps } from '../shared/types';
import { cn } from '../../../lib/utils';
import { ListChecksIcon as ListTodo } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useMemo } from 'react';

/** @deprecated Renders an OpenCode-only tool or todo list in an OpenCode session (pi has none). OpenCode is sunset (2026-10-23): no new code; delete with OpenCode. */
export function TodoWriteTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(call);
  const streamingInput = partStreamingInput(call);
  const metadata = partMetadata(call);

  const todos = useMemo(() => {
    // Codex `update_plan` sends `plan: [{ step, status }]`.
    const fromInput = parseTodos(input.todos ?? input.plan);
    if (fromInput.length) return fromInput;
    const fromMeta = parseTodos(metadata.todos);
    if (fromMeta.length) return fromMeta;
    const fromStream = parseTodos(streamingInput.todos);
    if (fromStream.length) return fromStream;
    // Claude Code `TaskCreate` / `TaskUpdate` carry one task: its `subject`, else its `taskId`.
    const id = input.taskId;
    return parseTodos([{ content: input.subject ?? (typeof id === 'string' || typeof id === 'number' ? `#${id}` : undefined), status: input.status }]);
  }, [input.todos, input.plan, input.subject, input.taskId, input.status, metadata.todos, streamingInput.todos]);

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
      trigger={{ title: tI18nHardcoded.raw('i18nComplete.textbd02b9a7d71d'), subtitle }}
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
ToolRegistry.register('todo-write', TodoWriteTool);
