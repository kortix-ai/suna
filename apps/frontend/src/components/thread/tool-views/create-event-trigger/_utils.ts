import { ToolCallData, ToolResultData } from '../types';

export interface TriggerData {
  provider: string;
  slug: string;
  is_active: boolean;
}

export interface CreateEventTriggerData {
  slug: string | null;
  profile_id: string | null;
  connected_account_id: string | null;
  trigger_config: Record<string, any> | null;
  name: string | null;
  agent_prompt: string | null;
  message: string | null;
  trigger: TriggerData | null;
  success?: boolean;
  timestamp?: string;
}

export function extractCreateEventTriggerData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CreateEventTriggerData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: CreateEventTriggerData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    slug: null,
    profile_id: null,
    connected_account_id: null,
    trigger_config: null,
    name: null,
    agent_prompt: null,
    message: null,
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
    slug: parsedOutput.slug || args.slug || null,
    profile_id: parsedOutput.profile_id || args.profile_id || null,
    connected_account_id: parsedOutput.connected_account_id || args.connected_account_id || null,
    trigger_config: parsedOutput.trigger_config || args.trigger_config || null,
    name: parsedOutput.name || args.name || null,
    agent_prompt: parsedOutput.agent_prompt || args.agent_prompt || null,
    message: parsedOutput.message || null,
    trigger: parsedOutput.trigger || null,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
