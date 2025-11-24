import { ToolCallData, ToolResultData } from '../types';

export interface CreateAgentScheduledTriggerData {
  agent_id: string | null;
  name: string | null;
  description?: string | null;
  cron_expression: string | null;
  agent_prompt?: string | null;
  trigger: {
    id: string;
    agent_id: string;
    name: string;
    description?: string;
    cron_expression: string;
    is_active: boolean;
    created_at: string;
  } | null;
  success?: boolean;
  timestamp?: string;
}

export function extractCreateAgentScheduledTriggerData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CreateAgentScheduledTriggerData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: CreateAgentScheduledTriggerData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    agent_id: null,
    name: null,
    description: null,
    cron_expression: null,
    agent_prompt: null,
    trigger: null,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  if (!toolResult?.output) {
    return defaultResult;
  }

  let parsedOutput: any = toolResult.output;
  if (typeof parsedOutput === 'string') {
    try {
      parsedOutput = JSON.parse(parsedOutput);
    } catch (e) {
      return { ...defaultResult, actualIsSuccess: false };
    }
  }

  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};

  return {
    agent_id: parsedOutput.agent_id || args.agent_id || null,
    name: parsedOutput.name || args.name || null,
    description: parsedOutput.description || args.description || null,
    cron_expression: parsedOutput.cron_expression || args.cron_expression || null,
    agent_prompt: parsedOutput.agent_prompt || args.agent_prompt || null,
    trigger: parsedOutput.trigger || null,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
