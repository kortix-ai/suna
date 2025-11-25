import { ToolCallData, ToolResultData } from '../types';

export interface AgentpressTool {
  enabled: boolean;
  description: string;
}

export interface CustomMcp {
  name: string;
  type: string;
  config: {
    url: string;
    headers?: Record<string, string>;
    profile_id?: string;
  };
  enabledTools: string[];
}

export interface AgentConfiguration {
  agent_id: string;
  name: string;
  description: string;
  agentpress_tools: Record<string, AgentpressTool>;
  configured_mcps: any[];
  custom_mcps: CustomMcp[];
  created_at: string;
  updated_at: string;
  current_version: string;
}

export interface GetCurrentAgentConfigData {
  summary: string | null;
  configuration: AgentConfiguration | null;
  success?: boolean;
  timestamp?: string;
}

export function extractGetCurrentAgentConfigData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  summary: string | null;
  configuration: AgentConfiguration | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let output: any = {};
  if (toolResult?.output) {
    if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = toolResult.output;
    } else if (typeof toolResult.output === 'string') {
      try {
        output = JSON.parse(toolResult.output);
      } catch (e) {
        // Not JSON, ignore
      }
    }
  }

  return {
    summary: output.summary || null,
    configuration: output.configuration || null,
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
