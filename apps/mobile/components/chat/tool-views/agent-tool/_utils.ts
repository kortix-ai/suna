import type { ParsedToolData } from '@/lib/utils/tool-parser';

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

export function extractAgentData(toolData: ParsedToolData): AgentData {
  const { result, arguments: args } = toolData;
  
  let data: any = {};
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
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
    success: result.success ?? true
  };
}

