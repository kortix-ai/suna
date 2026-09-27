/**
 * `agent_task_update` / `task_update` and the task action aliases. Port of
 * apps/web `tool/tools/agent-task-update-tool.tsx`: routes on `input.action` —
 * `start` → `AgentSpawnTool`, `cancel` → `AgentStopTool`, `approve` → a
 * body-less success-check row "Update task" · id · `approved`, anything else →
 * `AgentMessageTool`.
 */

import { CheckIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { agentTaskUpdateRoute, shortAgentId } from '@/lib/session/tools/agents-status';
import { BasicTool, partInput } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { AgentMessageTool } from './agent-message-tool';
import { AgentSpawnTool } from './agent-spawn-tool';
import { AgentStopTool } from './agent-stop-tool';
import { TaskDoneTool } from './task-done-tool';

const APPROVED_ARGS = ['approved'];

export function AgentTaskUpdateTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  switch (agentTaskUpdateRoute(input)) {
    case 'start':
      return <AgentSpawnTool part={part} defaultOpen={defaultOpen} forceOpen={forceOpen} />;
    case 'cancel':
      return <AgentStopTool part={part} forceOpen={forceOpen} />;
    case 'approve':
      return (
        <BasicTool
          disclosureId={disclosureKey('tool', part.id)}
          icon={<CheckIcon size={TURN_SPACE.icon} color={palette.success} />}
          trigger={{
            title: 'Update task',
            subtitle: shortAgentId((input.id as string) || ''),
            args: APPROVED_ARGS,
          }}
          forceOpen={forceOpen}
        />
      );
    case 'message':
      return <AgentMessageTool part={part} defaultOpen={defaultOpen} forceOpen={forceOpen} />;
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
