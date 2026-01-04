import { ToolCallData, ToolResultData } from '../types';

export interface UpdateAgentData {
  name: string | null;
  description?: string | null;
  system_prompt: string | null;
  agentpress_tools: Record<string, boolean> | null;
  configured_mcps?: any[] | null;
  is_default?: boolean;
  icon_name?: string | null;
  icon_color?: string | null;
  icon_background?: string | null;
  agent?: {
    agent_id: string;
    account_id: string;
    name: string;
    description?: string | null;
    is_default: boolean;
    created_at: string;
    updated_at: string;
    is_public: boolean;
    tags: string[];
    current_version_id: string;
    version_count: number;
    metadata: Record<string, any>;
    icon_name: string;
    icon_color: string;
    icon_background: string;
  } | null;
  updated_fields?: string[];
  version_created?: boolean;
  message?: string;
  success?: boolean;
  timestamp?: string;
}

export function extractUpdateAgentData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): UpdateAgentData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: UpdateAgentData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    name: null,
    description: null,
    system_prompt: null,
    agentpress_tools: null,
    configured_mcps: null,
    is_default: false,
    icon_name: null,
    icon_color: null,
    icon_background: null,
    agent: null,
    updated_fields: [],
    version_created: false,
    message: null,
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
    agentpress_tools: parsedOutput.agentpress_tools || args.agentpress_tools || null,
    configured_mcps: parsedOutput.configured_mcps || args.configured_mcps || null,
    is_default: parsedOutput.is_default ?? args.is_default ?? false,
    icon_name: parsedOutput.icon_name || args.icon_name || null,
    icon_color: parsedOutput.icon_color || args.icon_color || null,
    icon_background: parsedOutput.icon_background || args.icon_background || null,
    agent: parsedOutput.agent || null,
    updated_fields: parsedOutput.updated_fields || [],
    version_created: parsedOutput.version_created ?? false,
    message: parsedOutput.message || null,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
