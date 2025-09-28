import { extractToolData } from '../utils';

export interface Connection {
  external_user_id: string;
  app_slug: string;
  app_name: string;
  created_at: string;
  updated_at: string;
  is_active: boolean;
}

export interface CheckProfileConnectionData {
  profile_id: string | null;
  profile_name: string | null;
  app_name: string | null;
  app_slug: string | null;
  external_user_id: string | null;
  is_connected: boolean;
  connections: Connection[];
  connection_count: number;
  available_tools: string[];
  tool_count: number;
  message: string | null;
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

const extractFromNewFormat = (content: any): CheckProfileConnectionData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { 
      profile_id: null,
      profile_name: null,
      app_name: null,
      app_slug: null,
      external_user_id: null,
      is_connected: false,
      connections: [],
      connection_count: 0,
      available_tools: [],
      tool_count: 0,
      message: null,
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
      profile_name: parsedOutput.profile_name || null,
      app_name: parsedOutput.app_name || null,
      app_slug: parsedOutput.app_slug || null,
      external_user_id: parsedOutput.external_user_id || null,
      is_connected: parsedOutput.is_connected || false,
      connections: Array.isArray(parsedOutput.connections) ? parsedOutput.connections : [],
      connection_count: parsedOutput.connection_count || 0,
      available_tools: Array.isArray(parsedOutput.available_tools) ? parsedOutput.available_tools : [],
      tool_count: parsedOutput.tool_count || 0,
      message: parsedOutput.message || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };

    return extractedData;
  }

  if ('parameters' in parsedContent && 'output' in parsedContent) {
    const extractedData = {
      profile_id: parsedContent.parameters?.profile_id || null,
      profile_name: parsedContent.output?.profile_name || null,
      app_name: parsedContent.output?.app_name || null,
      app_slug: parsedContent.output?.app_slug || null,
      external_user_id: parsedContent.output?.external_user_id || null,
      is_connected: parsedContent.output?.is_connected || false,
      connections: Array.isArray(parsedContent.output?.connections) ? parsedContent.output.connections : [],
      connection_count: parsedContent.output?.connection_count || 0,
      available_tools: Array.isArray(parsedContent.output?.available_tools) ? parsedContent.output.available_tools : [],
      tool_count: parsedContent.output?.tool_count || 0,
      message: parsedContent.output?.message || null,
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
    profile_name: null,
    app_name: null,
    app_slug: null,
    external_user_id: null,
    is_connected: false,
    connections: [],
    connection_count: 0,
    available_tools: [],
    tool_count: 0,
    message: null,
    success: undefined,
    timestamp: undefined 
  };
};

const extractFromLegacyFormat = (content: any): Omit<CheckProfileConnectionData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    
    return {
      profile_id: args.profile_id || null,
      profile_name: null,
      app_name: null,
      app_slug: null,
      external_user_id: null,
      is_connected: false,
      connections: [],
      connection_count: 0,
      available_tools: [],
      tool_count: 0,
      message: null
    };
  }

  return {
    profile_id: null,
    profile_name: null,
    app_name: null,
    app_slug: null,
    external_user_id: null,
    is_connected: false,
    connections: [],
    connection_count: 0,
    available_tools: [],
    tool_count: 0,
    message: null
  };
};

export function extractCheckProfileConnectionData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  profile_id: string | null;
  profile_name: string | null;
  app_name: string | null;
  app_slug: string | null;
  external_user_id: string | null;
  is_connected: boolean;
  connections: Connection[];
  connection_count: number;
  available_tools: string[];
  tool_count: number;
  message: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: CheckProfileConnectionData;
  
  if (toolContent) {
    data = extractFromNewFormat(toolContent);
    if (data.success !== undefined || data.profile_name) {
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
    if (data.success !== undefined || data.profile_name) { 
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
    profile_name: toolLegacy.profile_name || assistantLegacy.profile_name,
    app_name: toolLegacy.app_name || assistantLegacy.app_name,
    app_slug: toolLegacy.app_slug || assistantLegacy.app_slug,
    external_user_id: toolLegacy.external_user_id || assistantLegacy.external_user_id,
    is_connected: toolLegacy.is_connected || assistantLegacy.is_connected,
    connections: toolLegacy.connections.length > 0 ? toolLegacy.connections : assistantLegacy.connections,
    connection_count: toolLegacy.connection_count || assistantLegacy.connection_count,
    available_tools: toolLegacy.available_tools.length > 0 ? toolLegacy.available_tools : assistantLegacy.available_tools,
    tool_count: toolLegacy.tool_count || assistantLegacy.tool_count,
    message: toolLegacy.message || assistantLegacy.message,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  return combinedData;
} 