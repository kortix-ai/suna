import { parseToolResult } from '../tool-result-parser';

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

export function extractDiscoverUserMcpServersData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): DiscoverUserMcpServersData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: DiscoverUserMcpServersData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    profile_id: null,
    message: null,
    profile_info: null,
    tools: [],
    total_tools: 0,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  try {
    if (toolContent) {
      let content = toolContent;
      
      if (typeof toolContent === 'string') {
        try {
          content = JSON.parse(toolContent);
        } catch (e) {
          content = toolContent;
        }
      }

      if (content && typeof content === 'object' && content.content) {
        try {
          const nestedContent = typeof content.content === 'string' ? JSON.parse(content.content) : content.content;
          content = nestedContent;
        } catch (e) {
        }
      }

      if (content && typeof content === 'object' && content.tool_execution) {
        const toolExecution = content.tool_execution;
        if (toolExecution.result && toolExecution.result.success) {
          const args = toolExecution.arguments;
          const output = toolExecution.result.output;

          if (args && output) {
            return {
              ...defaultResult,
              profile_id: args.profile_id || null,
              message: output.message || null,
              profile_info: output.profile_info || null,
              tools: output.tools || [],
              total_tools: output.total_tools || 0,
              actualIsSuccess: true
            };
          }
        }
      }

      if (content && typeof content === 'object' && content.tool === 'discover-user-mcp-servers') {
        const parameters = content.parameters;
        const output = content.output;
        
        if (parameters && output) {
          return {
            ...defaultResult,
            profile_id: parameters.profile_id || null,
            message: output.message || null,
            profile_info: output.profile_info || null,
            tools: output.tools || [],
            total_tools: output.total_tools || 0,
            actualIsSuccess: output.success !== false
          };
        }
      }
    }

    if (assistantContent) {
      const parsed = parseToolResult(assistantContent);
      if (parsed && parsed.isSuccess) {
        const toolOutput = parseContent(parsed.toolOutput);
        const args = parsed.arguments;

        if (args && toolOutput) {
          return {
            ...defaultResult,
            profile_id: args.profile_id || null,
            message: toolOutput.message || null,
            profile_info: toolOutput.profile_info || null,
            tools: toolOutput.tools || [],
            total_tools: toolOutput.total_tools || 0,
            actualIsSuccess: true
          };
        }
      }
    }

    return defaultResult;
  } catch (error) {
    console.error('Error extracting discover user mcp servers data:', error);
    return defaultResult;
  }
}
