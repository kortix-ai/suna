import { parseToolResult } from '../tool-result-parser';

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

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractSearchMcpServersData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): SearchMcpServersData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: SearchMcpServersData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    search_query: null,
    toolkits: null,
    total_found: 0,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  if (toolContent) {
    const parsedToolResult = parseToolResult(toolContent);
    
    if (parsedToolResult && parsedToolResult.functionName === 'search_mcp_servers_for_agent') {
      const args = parsedToolResult.arguments || {};
      
      let output: any = {};
      try {
        if (typeof parsedToolResult.toolOutput === 'string') {
          output = JSON.parse(parsedToolResult.toolOutput);
        } else if (typeof parsedToolResult.toolOutput === 'object') {
          output = parsedToolResult.toolOutput;
        }
      } catch (e) {
        const content = parseContent(toolContent);
        if (content?.tool_execution?.result?.output) {
          output = content.tool_execution.result.output;
        }
      }

      return {
        search_query: args.search_query || null,
        toolkits: output.toolkits || null,
        total_found: output.total_found || 0,
        success: parsedToolResult.isSuccess,
        timestamp: parsedToolResult.timestamp,
        actualIsSuccess: parsedToolResult.isSuccess,
        actualToolTimestamp: parsedToolResult.timestamp || toolTimestamp,
        actualAssistantTimestamp: assistantTimestamp
      };
    }
  }

  if (assistantContent) {
    const parsedToolResult = parseToolResult(assistantContent);
    
    if (parsedToolResult && parsedToolResult.functionName === 'search_mcp_servers_for_agent') {
      const args = parsedToolResult.arguments || {};
      
      let output: any = {};
      try {
        if (typeof parsedToolResult.toolOutput === 'string') {
          output = JSON.parse(parsedToolResult.toolOutput);
        } else if (typeof parsedToolResult.toolOutput === 'object') {
          output = parsedToolResult.toolOutput;
        }
      } catch (e) {
        const content = parseContent(assistantContent);
        if (content?.tool_execution?.result?.output) {
          output = content.tool_execution.result.output;
        }
      }

      return {
        search_query: args.search_query || null,
        toolkits: output.toolkits || null,
        total_found: output.total_found || 0,
        success: parsedToolResult.isSuccess,
        timestamp: parsedToolResult.timestamp,
        actualIsSuccess: parsedToolResult.isSuccess,
        actualToolTimestamp: toolTimestamp,
        actualAssistantTimestamp: parsedToolResult.timestamp || assistantTimestamp
      };
    }
  }

  return defaultResult;
} 