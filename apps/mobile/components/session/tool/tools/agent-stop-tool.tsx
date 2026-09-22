/**
 * `agent_stop` / `agent_task_cancel` / `task_cancel`. Port of apps/web
 * `tool/tools/agent-stop-tool.tsx`: a body-less row — `StopCircle` ·
 * "Stop agent" · the agent id's last 12 characters · `stopped`.
 *
 * Web's file also defines `parseTaskRows`, which nothing there calls; the live
 * copy is `@kortix/sdk`'s.
 */

import { useMemo } from 'react';
import { StopCircleIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { agentStopModel } from '@/lib/session/tools/agents-status';
import { BasicTool, partInput } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

export function AgentStopTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const model = useMemo(() => agentStopModel(input), [input]);
  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={StopCircleIcon}
      trigger={model}
      forceOpen={forceOpen}
    />
  );
}
ToolRegistry.register('agent_stop', AgentStopTool);
ToolRegistry.register('agent-stop', AgentStopTool);
