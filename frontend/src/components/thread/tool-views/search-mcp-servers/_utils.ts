import { ToolCallData, ToolResultData } from '../types';

export interface McpServerResult {
  name: string;
  toolkit_slug: string;
  description: string;
  logo_url: string;
  auth_schemes: string[];
  tags?: string[];
  categories?: string[];
}

export interface SearchMcpServersData {
  query: string | null;
  results: McpServerResult[];
  limit: number;
  success?: boolean;
  timestamp?: string;
}

export function extractSearchMcpServersData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  query: string | null;
  results: McpServerResult[];
  limit: number;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = toolCall.arguments || {};
  
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

  const results = Array.isArray(output.results) ? output.results : [];

  return {
    query: args.query || output.query || null,
    results,
    limit: args.limit || output.limit || 10,
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
