'use client';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import {
  BasicTool,
  isErrorOutput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import type { TriggerTitle } from '@/ui';
import { ListChecksIcon as ListTodo } from '@phosphor-icons/react';
import { useMemo } from 'react';

// Fully static, so it does not need rebuilding (object plus a fresh `args` array)
// on every render of every task row in a streaming session.
const TASK_LIST_TRIGGER: TriggerTitle = { title: 'Tasks', subtitle: '', args: [] };

export function TaskListTool({ part, forceOpen }: ToolProps) {
  const output = partOutput(part);
  // `isErrorOutput` trims the whole task list and attempts a `JSON.parse` over
  // it, from inside the JSX, on every render.
  const isError = useMemo(() => isErrorOutput(output), [output]);
  return (
    <BasicTool
      icon={<ListTodo className="size-3.5 shrink-0" />}
      trigger={TASK_LIST_TRIGGER}
      defaultOpen={false}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="task_list" />
      ) : output ? (
        <div data-scrollable className="max-h-48 overflow-auto px-3 py-2">
          <div className="text-muted-foreground text-xs whitespace-pre-wrap">
            <UnifiedMarkdown content={output} isStreaming={false} />
          </div>
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('task_list', TaskListTool);
ToolRegistry.register('task-list', TaskListTool);
ToolRegistry.register('task_get', TaskListTool);
ToolRegistry.register('task-get', TaskListTool);
ToolRegistry.register('agent_task_get', TaskListTool);
ToolRegistry.register('agent-task-get', TaskListTool);
