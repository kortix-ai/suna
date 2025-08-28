import { parseToolResult } from '../tool-result-parser';

export interface ConfigureAgentIntegrationData {
  agent_id: string | null;
  profile_name: string | null;
  enabled_tools: string[] | null;
  display_name: string | null;
  integration_name: string | null;
  enabled_tools_count: number;
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

export function extractConfigureAgentIntegrationData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ConfigureAgentIntegrationData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: ConfigureAgentIntegrationData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    agent_id: null,
    profile_name: null,
    enabled_tools: null,
    display_name: null,
    integration_name: null,
    enabled_tools_count: 0,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  if (toolContent) {
    const parsedToolResult = parseToolResult(toolContent);
    
    if (parsedToolResult && parsedToolResult.functionName === 'configure_agent_integration') {
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
        agent_id: args.agent_id || output.agent_id || null,
        profile_name: args.profile_name || output.profile_name || null,
        enabled_tools: args.enabled_tools || output.enabled_tools || null,
        display_name: args.display_name || output.display_name || null,
        integration_name: output.integration_name || null,
        enabled_tools_count: output.enabled_tools_count || (args.enabled_tools?.length || 0),
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
    
    if (parsedToolResult && parsedToolResult.functionName === 'configure_agent_integration') {
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
        agent_id: args.agent_id || output.agent_id || null,
        profile_name: args.profile_name || output.profile_name || null,
        enabled_tools: args.enabled_tools || output.enabled_tools || null,
        display_name: args.display_name || output.display_name || null,
        integration_name: output.integration_name || null,
        enabled_tools_count: output.enabled_tools_count || (args.enabled_tools?.length || 0),
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