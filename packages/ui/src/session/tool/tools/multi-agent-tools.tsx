'use client';

import { partError, partInput, partRawOutput, partStatus } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolComponent, ToolProps } from '../shared/types';
import { AgentSpawnTool } from './agent-spawn-tool';
import { AgentTaskUpdateTool } from './agent-task-update-tool';
import { KortixActionTool } from './kortix-action-tool';
import { parseKortixToolResult } from './kortix-tool-card';
import { looksLikeTeamTaskInput } from './multi-agent-tool-data';
import { TaskListTool } from './task-list-tool';

/**
 * `task_create`, `task_list`, `task_get` and `task_update` name two tools: pi's
 * team task tools (flag `agent_teams`), which answer with a `KortixToolResult`
 * card, and the older plugin tools of a transcript from before pi, which render
 * their own rows. The output decides; a call still running decides by its input
 * (pi's take a `subject`, a task number, a status or an owner).
 */
export function isTeamTaskCall(call: ToolProps['call']): boolean {
  const status = partStatus(call);
  if (status === 'completed' || status === 'error') {
    const raw = status === 'error' ? (partError(call) ?? '') : partRawOutput(call);
    return parseKortixToolResult(raw, call.name) !== null;
  }
  return looksLikeTeamTaskInput(partInput(call));
}

function teamTaskTool(legacy: ToolComponent): ToolComponent {
  function TeamTaskTool(props: ToolProps) {
    const Component = isTeamTaskCall(props.call) ? KortixActionTool : legacy;
    return <Component {...props} />;
  }
  TeamTaskTool.displayName = `TeamTaskTool(${legacy.displayName ?? legacy.name})`;
  return TeamTaskTool;
}

// Registered after the older tools (`register.ts` imports this file last), so these win their keys.
ToolRegistry.register('task-create', teamTaskTool(AgentSpawnTool));
ToolRegistry.register('task-update', teamTaskTool(AgentTaskUpdateTool));
ToolRegistry.register('task-list', teamTaskTool(TaskListTool));
ToolRegistry.register('task-get', teamTaskTool(TaskListTool));
