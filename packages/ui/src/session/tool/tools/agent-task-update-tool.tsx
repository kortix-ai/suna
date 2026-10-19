'use client';

import { STATUS_TEXT } from '../../../components/ui/status';
import { BasicTool, partInput } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { cn } from '../../../lib/utils';
import { CheckIcon as Check } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';

import { AgentMessageTool } from './agent-message-tool';
import { AgentSpawnTool } from './agent-spawn-tool';
import { AgentStopTool } from './agent-stop-tool';
import { TaskDoneTool } from './task-done-tool';

export function AgentTaskUpdateTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const action = (input.action as string) || '';
  switch (action) {
    case 'start':
      return <AgentSpawnTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} />;
    case 'message':
      return <AgentMessageTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} />;
    case 'cancel':
      return <AgentStopTool call={call} forceOpen={forceOpen} />;
    case 'approve': {
      const taskId = (input.id as string) || '';
      return (
        <BasicTool
          icon={<Check className={cn('size-3.5 shrink-0', STATUS_TEXT.success)} />}
          trigger={{
            title: tI18nComplete.raw('text4b8fa0516b54'),
            subtitle: taskId ? taskId.slice(-12) : undefined,
            args: ['approved'],
          }}
          forceOpen={forceOpen}
        />
      );
    }
    default:
      return <AgentMessageTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} />;
  }
}
ToolRegistry.register('agent-task-update', AgentTaskUpdateTool);
ToolRegistry.register('task-update', AgentTaskUpdateTool);
ToolRegistry.register('agent-task-message', AgentMessageTool);
ToolRegistry.register('task-message', AgentMessageTool);
ToolRegistry.register('agent-task-approve', TaskDoneTool);
ToolRegistry.register('agent-task-cancel', AgentStopTool);
ToolRegistry.register('task-approve', TaskDoneTool);
ToolRegistry.register('task-cancel', AgentStopTool);
