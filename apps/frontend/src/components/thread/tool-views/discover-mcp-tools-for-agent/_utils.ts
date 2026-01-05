import { ToolCallData, ToolResultData } from '../types';

export interface DiscoverMcpToolsData {
  profile_name: string | null;
  toolkit_name: string | null;
  toolkit_slug: string | null;
  tools: Array<{name: string; description?: string}> | null;
  tool_names: string[] | null;
  total_tools: number;
  is_connected: boolean;
  success?: boolean;
  timestamp?: string;
}

export function extractDiscoverMcpToolsData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): DiscoverMcpToolsData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: DiscoverMcpToolsData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    profile_name: null,
    toolkit_name: null,
    toolkit_slug: null,
    tools: null,
    tool_names: null,
    total_tools: 0,
    is_connected: false,
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
    profile_name: parsedOutput.profile_name || args.profile_name || null,
    toolkit_name: parsedOutput.toolkit_name || null,
    toolkit_slug: parsedOutput.toolkit_slug || args.toolkit_slug || null,
    tools: Array.isArray(parsedOutput.tools) ? parsedOutput.tools : null,
    tool_names: Array.isArray(parsedOutput.tool_names) ? parsedOutput.tool_names : null,
    total_tools: parsedOutput.total_tools ?? 0,
    is_connected: parsedOutput.is_connected ?? false,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
