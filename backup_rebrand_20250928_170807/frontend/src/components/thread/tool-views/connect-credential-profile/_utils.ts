import { extractToolData } from '../utils';

export interface ConnectCredentialProfileData {
  profile_id: string | null;
  message: string | null;
  profile_name: string | null;
  app_name: string | null;
  app_slug: string | null;
  connection_link: string | null;
  external_user_id: string | null;
  expires_at: string | null;
  instructions: string | null;
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

const extractFromNewFormat = (content: any): ConnectCredentialProfileData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { 
      profile_id: null, 
      message: null, 
      profile_name: null, 
      app_name: null, 
      app_slug: null,
      connection_link: null, 
      external_user_id: null, 
      expires_at: null, 
      instructions: null, 
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
      message: parsedOutput.message || null,
      profile_name: parsedOutput.profile_name || null,
      app_name: parsedOutput.app_name || null,
      app_slug: parsedOutput.app_slug || null,
      connection_link: parsedOutput.connection_link || null,
      external_user_id: parsedOutput.external_user_id || null,
      expires_at: parsedOutput.expires_at || null,
      instructions: parsedOutput.instructions || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };

    return extractedData;
  }

  if ('parameters' in parsedContent && 'output' in parsedContent) {
    const extractedData = {
      profile_id: parsedContent.parameters?.profile_id || null,
      message: parsedContent.output?.message || null,
      profile_name: parsedContent.output?.profile_name || null,
      app_name: parsedContent.output?.app_name || null,
      app_slug: parsedContent.output?.app_slug || null,
      connection_link: parsedContent.output?.connection_link || null,
      external_user_id: parsedContent.output?.external_user_id || null,
      expires_at: parsedContent.output?.expires_at || null,
      instructions: parsedContent.output?.instructions || null,
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
    message: null, 
    profile_name: null, 
    app_name: null, 
    app_slug: null,
    connection_link: null, 
    external_user_id: null, 
    expires_at: null, 
    instructions: null, 
    success: undefined, 
    timestamp: undefined 
  };
};

const extractFromLegacyFormat = (content: any): Omit<ConnectCredentialProfileData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    
    return {
      profile_id: args.profile_id || null,
      message: null,
      profile_name: null,
      app_name: null,
      app_slug: null,
      connection_link: null,
      external_user_id: null,
      expires_at: null,
      instructions: null
    };
  }

  return {
    profile_id: null,
    message: null,
    profile_name: null,
    app_name: null,
    app_slug: null,
    connection_link: null,
    external_user_id: null,
    expires_at: null,
    instructions: null
  };
};

export function extractConnectCredentialProfileData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  profile_id: string | null;
  message: string | null;
  profile_name: string | null;
  app_name: string | null;
  app_slug: string | null;
  connection_link: string | null;
  external_user_id: string | null;
  expires_at: string | null;
  instructions: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: ConnectCredentialProfileData;

  if (toolContent) {
    data = extractFromNewFormat(toolContent);
    if (data.success !== undefined || data.connection_link) {
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
    if (data.success !== undefined || data.connection_link) { 
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
    message: toolLegacy.message || assistantLegacy.message,
    profile_name: toolLegacy.profile_name || assistantLegacy.profile_name,
    app_name: toolLegacy.app_name || assistantLegacy.app_name,
    app_slug: toolLegacy.app_slug || assistantLegacy.app_slug,
    connection_link: toolLegacy.connection_link || assistantLegacy.connection_link,
    external_user_id: toolLegacy.external_user_id || assistantLegacy.external_user_id,
    expires_at: toolLegacy.expires_at || assistantLegacy.expires_at,
    instructions: toolLegacy.instructions || assistantLegacy.instructions,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  return combinedData;
} 