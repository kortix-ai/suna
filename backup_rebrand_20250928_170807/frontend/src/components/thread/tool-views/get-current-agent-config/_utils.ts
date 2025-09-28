import { extractToolData } from '../utils';

export interface AgentpressTool {
  enabled: boolean;
  description: string;
}

export interface CustomMcp {
  name: string;
  type: string;
  config: {
    url: string;
    headers?: Record<string, string>;
    profile_id?: string;
  };
  enabledTools: string[];
}

export interface AgentConfiguration {
  agent_id: string;
  name: string;
  description: string;
  agentpress_tools: Record<string, AgentpressTool>;
  configured_mcps: any[];
  custom_mcps: CustomMcp[];
  created_at: string;
  updated_at: string;
  current_version: string;
}

export interface GetCurrentAgentConfigData {
  summary: string | null;
  configuration: AgentConfiguration | null;
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

const extractFromNewFormat = (content: any): GetCurrentAgentConfigData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { 
      summary: null,
      configuration: null,
      success: undefined,
      timestamp: undefined 
    };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
      }
    }
    parsedOutput = parsedOutput || {};

    const extractedData = {
      summary: parsedOutput.summary || null,
      configuration: parsedOutput.configuration || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    
    return extractedData;
  }

  if ('parameters' in parsedContent && 'output' in parsedContent) {
    const extractedData = {
      summary: parsedContent.output?.summary || null,
      configuration: parsedContent.output?.configuration || null,
      success: parsedContent.success,
      timestamp: undefined
    };

    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { 
    summary: null,
    configuration: null,
    success: undefined,
    timestamp: undefined 
  };
};

const extractFromLegacyFormat = (content: any): Omit<GetCurrentAgentConfigData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    return {
      summary: null,
      configuration: null
    };
  }
  
  return {
    summary: null,
    configuration: null
  };
};

export function extractGetCurrentAgentConfigData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  summary: string | null;
  configuration: AgentConfiguration | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: GetCurrentAgentConfigData;
  
  if (toolContent) {
    data = extractFromNewFormat(toolContent);
    if (data.success !== undefined || data.configuration || data.summary) {
      return {
        ...data,
        actualIsSuccess: data.success !== undefined ? data.success : isSuccess,
        actualToolTimestamp: data.timestamp || toolTimestamp,
        actualAssistantTimestamp: assistantTimestamp
      };
    }
  }

  if (assistantContent) {
    data = extractFromNewFormat(assistantContent);
    if (data.success !== undefined || data.configuration || data.summary) {
      return {
        ...data,
        actualIsSuccess: data.success !== undefined ? data.success : isSuccess,
        actualToolTimestamp: toolTimestamp,
        actualAssistantTimestamp: data.timestamp || assistantTimestamp
      };
    }
  }

  const toolLegacy = extractFromLegacyFormat(toolContent);
  const assistantLegacy = extractFromLegacyFormat(assistantContent);

  const combinedData = {
    summary: toolLegacy.summary || assistantLegacy.summary,
    configuration: toolLegacy.configuration || assistantLegacy.configuration,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  return combinedData;
} 