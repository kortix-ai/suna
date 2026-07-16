'use client';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import {
  ListTodo,
} from 'lucide-react';


export function TaskListTool({ part }: ToolProps) {
  const output = partOutput(part);
  return (
    <BasicTool
      icon={<ListTodo className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Tasks', subtitle: '', args: [] }}
      defaultOpen={false}
    >
      {isErrorOutput(output) ? (
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

