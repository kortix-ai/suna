import { ToolCallData, ToolResultData } from '../types';

export interface SearchMcpServersData {
  search_query: string | null;
  toolkits: Array<{
    name: string;
    slug: string;
    description?: string;
    categories?: string[];
  }> | null;
  total_found: number;
  success?: boolean;
  timestamp?: string;
}

export function extractSearchMcpServersData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): SearchMcpServersData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: SearchMcpServersData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    search_query: null,
    toolkits: null,
    total_found: 0,
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
    search_query: parsedOutput.search_query || args.search_query || null,
    toolkits: Array.isArray(parsedOutput.toolkits) ? parsedOutput.toolkits : null,
    total_found: parsedOutput.total_found ?? 0,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
