import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface AgentData {
  agent_id?: string;
  agent_name?: string;
  message?: string;
  config?: any;
  triggers?: any[];
  trigger?: any;
  success: boolean;
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

export function extractAgentData(
  toolCall: ToolCallData | null,
  toolResult?: ToolResultData | null
): AgentData {
  // Handle null/undefined cases
  if (!toolCall) {
    return {
      success: toolResult?.success ?? false
    };
  }

  // Parse arguments
  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
      args = toolCall.arguments;
    } else if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    }
  }
  
  let data: any = {};
  
  // Extract from tool result output
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      data = output;
    }
  }
  
  return {
    agent_id: data.agent_id || args?.agent_id,
    agent_name: data.agent_name || args?.agent_name,
    message: data.message,
    config: data.config,
    triggers: data.triggers,
    trigger: data.trigger,
    success: toolResult?.success ?? true
  };
}

