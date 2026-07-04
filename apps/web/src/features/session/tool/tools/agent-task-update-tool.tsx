'use client';

import { STATUS_TEXT } from '@/components/ui/status';
import { partInput } from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentMessageTool } from '@/features/session/tool/tools/agent-message-tool';
import { AgentSpawnTool } from '@/features/session/tool/tools/agent-spawn-tool';
import { AgentStopTool } from '@/features/session/tool/tools/agent-stop-tool';
import { TaskDoneTool } from '@/features/session/tool/tools/task-done-tool';

export function AgentTaskUpdateTool({ part, forceOpen }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        <div className="text-muted-foreground/70 flex items-center gap-1.5 py-0.5 text-xs">
          <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
          <span className="text-foreground/80 flex-1 truncate">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line6643JsxTextTaskApproved')}{' '}
            {taskId ? ` · ${taskId.slice(-12)}` : ''}
          </span>
        </div>
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
