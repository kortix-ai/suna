import { extractToolData } from '../utils';

export interface ConfigureProfileForAgentData {
  profile_id: string | null;
  enabled_tools: string[];
  display_name: string | null;
  message: string | null;
  total_tools: number;
  version_id: string | null;
  version_name: string | null;
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

const extractFromNewFormat = (content: any): ConfigureProfileForAgentData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { 
      profile_id: null,
      enabled_tools: [],
      display_name: null,
      message: null,
      total_tools: 0,
      version_id: null,
      version_name: null,
      success: undefined,
      timestamp: undefined 
    };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
      }
    }
    parsedOutput = parsedOutput || {};

    const extractedData = {
      profile_id: args.profile_id || null,
      enabled_tools: Array.isArray(args.enabled_tools) 
        ? args.enabled_tools 
        : Array.isArray(parsedOutput.enabled_tools) 
          ? parsedOutput.enabled_tools 
          : [],
      display_name: args.display_name || null,
      message: parsedOutput.message || null,
      total_tools: parsedOutput.total_tools || 0,
      version_id: parsedOutput.version_id || null,
      version_name: parsedOutput.version_name || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    
    return extractedData;
  }

  if ('parameters' in parsedContent && 'output' in parsedContent) {
    const extractedData = {
      profile_id: parsedContent.parameters?.profile_id || null,
      enabled_tools: Array.isArray(parsedContent.parameters?.enabled_tools) 
        ? parsedContent.parameters.enabled_tools 
        : Array.isArray(parsedContent.output?.enabled_tools) 
          ? parsedContent.output.enabled_tools 
          : [],
      display_name: parsedContent.parameters?.display_name || null,
      message: parsedContent.output?.message || null,
      total_tools: parsedContent.output?.total_tools || 0,
      version_id: parsedContent.output?.version_id || null,
      version_name: parsedContent.output?.version_name || null,
      success: parsedContent.success,
      timestamp: undefined
    };

    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { 
    profile_id: null,
    enabled_tools: [],
    display_name: null,
    message: null,
    total_tools: 0,
    version_id: null,
    version_name: null,
    success: undefined,
    timestamp: undefined 
  };
};

const extractFromLegacyFormat = (content: any): Omit<ConfigureProfileForAgentData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    
    return {
      profile_id: args.profile_id || null,
      enabled_tools: Array.isArray(args.enabled_tools) ? args.enabled_tools : [],
      display_name: args.display_name || null,
      message: null,
      total_tools: 0,
      version_id: null,
      version_name: null
    };
  }
  
  return {
    profile_id: null,
    enabled_tools: [],
    display_name: null,
    message: null,
    total_tools: 0,
    version_id: null,
    version_name: null
  };
};

export function extractConfigureProfileForAgentData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  profile_id: string | null;
  enabled_tools: string[];
  display_name: string | null;
  message: string | null;
  total_tools: number;
  version_id: string | null;
  version_name: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: ConfigureProfileForAgentData;
  
  if (toolContent) {
    data = extractFromNewFormat(toolContent);
    if (data.success !== undefined || data.message || data.enabled_tools.length > 0) {
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
    if (data.success !== undefined || data.message || data.enabled_tools.length > 0) {
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
    profile_id: toolLegacy.profile_id || assistantLegacy.profile_id,
    enabled_tools: toolLegacy.enabled_tools.length > 0 ? toolLegacy.enabled_tools : assistantLegacy.enabled_tools,
    display_name: toolLegacy.display_name || assistantLegacy.display_name,
    message: toolLegacy.message || assistantLegacy.message,
    total_tools: toolLegacy.total_tools || assistantLegacy.total_tools,
    version_id: toolLegacy.version_id || assistantLegacy.version_id,
    version_name: toolLegacy.version_name || assistantLegacy.version_name,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  return combinedData;
} 