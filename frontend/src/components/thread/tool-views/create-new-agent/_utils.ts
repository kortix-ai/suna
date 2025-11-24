import { ToolCallData, ToolResultData } from '../types';

export interface AgentCreationData {
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  icon_name: string | null;
  icon_color: string | null;
  icon_background: string | null;
  agentpress_tools: Record<string, boolean> | null;
  configured_mcps: any[] | null;
  is_default: boolean;
  agent_id: string | null;
  agent_name: string | null;
  success?: boolean;
  timestamp?: string;
}

export function extractCreateNewAgentData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): AgentCreationData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: AgentCreationData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    name: null,
    description: null,
    system_prompt: null,
    icon_name: null,
    icon_color: null,
    icon_background: null,
    agentpress_tools: null,
    configured_mcps: null,
    is_default: false,
    agent_id: null,
    agent_name: null,
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
    name: parsedOutput.name || args.name || null,
    description: parsedOutput.description || args.description || null,
    system_prompt: parsedOutput.system_prompt || args.system_prompt || null,
    icon_name: parsedOutput.icon_name || args.icon_name || null,
    icon_color: parsedOutput.icon_color || args.icon_color || null,
    icon_background: parsedOutput.icon_background || args.icon_background || null,
    agentpress_tools: parsedOutput.agentpress_tools || args.agentpress_tools || null,
    configured_mcps: parsedOutput.configured_mcps || args.configured_mcps || null,
    is_default: parsedOutput.is_default ?? args.is_default ?? false,
    agent_id: parsedOutput.agent_id || null,
    agent_name: parsedOutput.agent_name || args.name || null,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
