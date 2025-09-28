import { parseToolResult } from '../tool-result-parser';

export interface AgentCreationData {
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  icon_name: string | null;
  icon_color: string | null;
  icon_background: string | null;
  agentpress_tools: Record<string, boolean> | null;
  configured_mcps: any[] | null;
  is_default: boolean;
  agent_id: string | null;
  agent_name: string | null;
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

export function extractCreateNewAgentData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): AgentCreationData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: AgentCreationData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    name: null,
    description: null,
    system_prompt: null,
    icon_name: null,
    icon_color: null,
    icon_background: null,
    agentpress_tools: null,
    configured_mcps: null,
    is_default: false,
    agent_id: null,
    agent_name: null,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  if (toolContent) {
    const parsedToolResult = parseToolResult(toolContent);
    
    if (parsedToolResult && parsedToolResult.functionName === 'create_new_agent') {
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
        name: args.name || null,
        description: args.description || null,
        system_prompt: args.system_prompt || null,
        icon_name: args.icon_name || null,
        icon_color: args.icon_color || null,
        icon_background: args.icon_background || null,
        agentpress_tools: args.agentpress_tools || null,
        configured_mcps: args.configured_mcps || null,
        is_default: args.is_default || false,
        agent_id: output.agent_id || null,
        agent_name: output.agent_name || args.name || null,
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
    
    if (parsedToolResult && parsedToolResult.functionName === 'create_new_agent') {
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
        name: args.name || null,
        description: args.description || null,
        system_prompt: args.system_prompt || null,
        icon_name: args.icon_name || null,
        icon_color: args.icon_color || null,
        icon_background: args.icon_background || null,
        agentpress_tools: args.agentpress_tools || null,
        configured_mcps: args.configured_mcps || null,
        is_default: args.is_default || false,
        agent_id: output.agent_id || null,
        agent_name: output.agent_name || args.name || null,
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