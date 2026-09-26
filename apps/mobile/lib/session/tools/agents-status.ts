/**
 * Pure logic behind the agent rows: `agent_status`, `agent_message`,
 * `agent_stop`, and `agent_task_update` routing (web `tool/tools/agent-*-tool.tsx`).
 *
 * Strings are web's English locale (`hardcodedUi.i18nComplete`):
 * `textca9c05caf0c3` "Agent status", `text0ebb429fa86d` "task",
 * `text8833ce4e6595` "Message agent", `text8116da8fa64c` "Message → {value0}",
 * `texta8b750b1f323` "Stop agent", `text4b8fa0516b54` "Update task".
 */

import { cleanWorkerOutput, isErrorOutput, parseTaskRows } from '@kortix/sdk';

export type TaskRow = ReturnType<typeof parseTaskRows>[number];

/** Web `id.slice(-12)`, `undefined` for an empty id. */
export function shortAgentId(id: string): string | undefined {
  return id ? id.slice(-12) : undefined;
}

export function agentStatusModel({ status, output }: { status: string; output: string }) {
  const isRunning = status === 'running' || status === 'pending';
  const taskRows = parseTaskRows(output);
  const cleanedOutput = cleanWorkerOutput(output);
  const isError = isErrorOutput(output);
  return {
    title: 'Agent status',
    isRunning,
    taskRows,
    cleanedOutput,
    isError,
    badge:
      !isRunning && taskRows.length > 0
        ? `${taskRows.length} task${taskRows.length !== 1 ? 's' : ''}`
        : undefined,
    showRows: !isRunning && taskRows.length > 0,
    showError: !isRunning && isError,
    showRaw: !isRunning && !isError && taskRows.length === 0 && Boolean(cleanedOutput),
  };
}

export function agentMessageModel({
  status,
  input,
  output,
}: {
  status: string;
  input: Record<string, unknown>;
  output: string;
}) {
  const rawMessage = (input.message as string) || '';
  const taskId = (input.id as string) || (input.agent_id as string) || '';
  const isError = status === 'error' || (status === 'completed' && isErrorOutput(output));
  return {
    title: 'Message agent',
    subtitle: shortAgentId(taskId),
    args: isError ? ['failed'] : undefined,
    isError,
    rawMessage,
    sessionTitle: `Message → ${taskId || 'worker'}`,
  };
}

export function agentStopModel(input: Record<string, unknown>) {
  const agentId = (input.agent_id as string) || '';
  return { title: 'Stop agent', subtitle: shortAgentId(agentId), args: ['stopped'] };
}

export type AgentTaskUpdateRoute = 'start' | 'message' | 'cancel' | 'approve';

/** Web `AgentTaskUpdateTool`'s `switch (input.action)`; unknown actions render as a message. */
export function agentTaskUpdateRoute(input: Record<string, unknown>): AgentTaskUpdateRoute {
  const action = (input.action as string) || '';
  return action === 'start' || action === 'cancel' || action === 'approve' ? action : 'message';
}
