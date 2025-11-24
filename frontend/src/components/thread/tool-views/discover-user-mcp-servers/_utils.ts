import { ToolCallData, ToolResultData } from '../types';

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: any;
}

export interface ProfileInfo {
  profile_name: string;
  toolkit_name: string;
  toolkit_slug: string;
  is_connected: boolean;
}

export interface DiscoverUserMcpServersData {
  profile_id: string | null;
  message: string | null;
  profile_info: ProfileInfo | null;
  tools: McpTool[];
  total_tools: number;
  success?: boolean;
  timestamp?: string;
}

export function extractDiscoverUserMcpServersData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): DiscoverUserMcpServersData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: DiscoverUserMcpServersData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    profile_id: null,
    message: null,
    profile_info: null,
    tools: [],
    total_tools: 0,
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
    profile_id: parsedOutput.profile_id || args.profile_id || null,
    message: parsedOutput.message || null,
    profile_info: parsedOutput.profile_info || null,
    tools: Array.isArray(parsedOutput.tools) ? parsedOutput.tools : [],
    total_tools: parsedOutput.total_tools ?? 0,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
