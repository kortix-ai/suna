'use client';

import { STATUS_TEXT } from '@/components/ui/status';
import { BasicTool, partInput } from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';

import { AgentMessageTool } from '@/features/session/tool/tools/agent-message-tool';
import { AgentSpawnTool } from '@/features/session/tool/tools/agent-spawn-tool';
import { AgentStopTool } from '@/features/session/tool/tools/agent-stop-tool';
import { TaskDoneTool } from '@/features/session/tool/tools/task-done-tool';

export function AgentTaskUpdateTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const action = (input.action as string) || '';
  switch (action) {
    case 'start':
      return <AgentSpawnTool part={part} forceOpen={forceOpen} />;
    case 'message':
      return <AgentMessageTool part={part} forceOpen={forceOpen} />;
    case 'cancel':
      return <AgentStopTool part={part} forceOpen={forceOpen} />;
    case 'approve': {
      const taskId = (input.id as string) || '';
      return (
        <BasicTool
          icon={<Check className={cn('size-3.5 flex-shrink-0', STATUS_TEXT.success)} />}
          trigger={{
            title: 'Update task',
            subtitle: taskId ? taskId.slice(-12) : undefined,
            args: ['approved'],
          }}
          forceOpen={forceOpen}
        />
      );
    }
    default:
      return <AgentMessageTool part={part} forceOpen={forceOpen} />;
  }
}
ToolRegistry.register('agent_task_update', AgentTaskUpdateTool);
ToolRegistry.register('agent-task-update', AgentTaskUpdateTool);
ToolRegistry.register('task_update', AgentTaskUpdateTool);
ToolRegistry.register('task-update', AgentTaskUpdateTool);
ToolRegistry.register('agent_task_message', AgentMessageTool);
ToolRegistry.register('agent-task-message', AgentMessageTool);
ToolRegistry.register('task_message', AgentMessageTool);
ToolRegistry.register('task-message', AgentMessageTool);
ToolRegistry.register('agent_task_approve', TaskDoneTool);
ToolRegistry.register('agent-task-approve', TaskDoneTool);
ToolRegistry.register('agent_task_cancel', AgentStopTool);
ToolRegistry.register('agent-task-cancel', AgentStopTool);
ToolRegistry.register('task_approve', TaskDoneTool);
ToolRegistry.register('task-approve', TaskDoneTool);
ToolRegistry.register('task_cancel', AgentStopTool);
ToolRegistry.register('task-cancel', AgentStopTool);
