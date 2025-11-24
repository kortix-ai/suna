import { ToolCallData, ToolResultData } from '../types';

export interface ConfigureProfileForAgentData {
  profile_id: string | null;
  enabled_tools: string[];
  display_name: string | null;
  message: string | null;
  total_tools: number;
  version_id: string | null;
  version_name: string | null;
  success?: boolean;
  timestamp?: string;
}

export function extractConfigureProfileForAgentData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  profile_id: string | null;
  enabled_tools: string[];
  display_name: string | null;
  message: string | null;
  total_tools: number;
  version_id: string | null;
  version_name: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  // Extract from toolCall.arguments
  const args = toolCall.arguments || {};
  
  // Extract from toolResult.output
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

  const enabled_tools = Array.isArray(args.enabled_tools) 
    ? args.enabled_tools 
    : Array.isArray(output.enabled_tools) 
      ? output.enabled_tools 
      : [];

  return {
    profile_id: args.profile_id || output.profile_id || null,
    enabled_tools,
    display_name: args.display_name || output.display_name || null,
    message: output.message || null,
    total_tools: output.total_tools || enabled_tools.length || 0,
    version_id: output.version_id || null,
    version_name: output.version_name || null,
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
} 