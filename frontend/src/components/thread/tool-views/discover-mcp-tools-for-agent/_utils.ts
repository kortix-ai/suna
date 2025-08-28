import { parseToolResult } from '../tool-result-parser';

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

export function extractDiscoverMcpToolsData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): DiscoverMcpToolsData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: DiscoverMcpToolsData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    profile_name: null,
    toolkit_name: null,
    toolkit_slug: null,
    tools: null,
    tool_names: null,
    total_tools: 0,
    is_connected: false,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  // Try parsing toolContent first
  if (toolContent) {
    const parsedToolResult = parseToolResult(toolContent);
    
    if (parsedToolResult && parsedToolResult.functionName === 'discover_mcp_tools_for_agent') {
      const args = parsedToolResult.arguments || {};
      
      // Parse the tool output which contains the result
      let output: any = {};
      try {
        if (typeof parsedToolResult.toolOutput === 'string') {
          output = JSON.parse(parsedToolResult.toolOutput);
        } else if (typeof parsedToolResult.toolOutput === 'object') {
          output = parsedToolResult.toolOutput;
        }
      } catch (e) {
        // If parsing fails, try to extract from the content directly
        const content = parseContent(toolContent);
        if (content?.tool_execution?.result?.output) {
          output = content.tool_execution.result.output;
        }
      }

      return {
        profile_name: args.profile_name || output.profile_name || null,
        toolkit_name: output.toolkit_name || null,
        toolkit_slug: output.toolkit_slug || null,
        tools: output.tools || null,
        tool_names: output.tool_names || null,
        total_tools: output.total_tools || 0,
        is_connected: output.is_connected || false,
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
    
    if (parsedToolResult && parsedToolResult.functionName === 'discover_mcp_tools_for_agent') {
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
        profile_name: args.profile_name || output.profile_name || null,
        toolkit_name: output.toolkit_name || null,
        toolkit_slug: output.toolkit_slug || null,
        tools: output.tools || null,
        tool_names: output.tool_names || null,
        total_tools: output.total_tools || 0,
        is_connected: output.is_connected || false,
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