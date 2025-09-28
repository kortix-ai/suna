import { extractToolData } from '../utils';

export interface CredentialProfile {
  profile_id: string;
  profile_name: string;
  display_name: string;
  toolkit_slug: string;
  toolkit_name: string;
  mcp_url: string;
  redirect_url?: string;
  is_connected: boolean;
  auth_required?: boolean;
}

export interface CreateCredentialProfileData {
  toolkit_slug: string | null;
  profile_name: string | null;
  display_name: string | null;
  message: string | null;
  profile: CredentialProfile | null;
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

const extractFromNewFormat = (content: any): CreateCredentialProfileData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { toolkit_slug: null, profile_name: null, display_name: null, message: null, profile: null, success: undefined, timestamp: undefined };
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
      toolkit_slug: args.toolkit_slug || null,
      profile_name: args.profile_name || null,
      display_name: args.display_name || null,
      message: parsedOutput.message || null,
      profile: parsedOutput.profile || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    
    return extractedData;
  }

  if ('parameters' in parsedContent && 'output' in parsedContent) {
    const extractedData = {
      toolkit_slug: parsedContent.parameters?.toolkit_slug || null,
      profile_name: parsedContent.parameters?.profile_name || null,
      display_name: parsedContent.parameters?.display_name || null,
      message: parsedContent.output?.message || null,
      profile: parsedContent.output?.profile || null,
      success: parsedContent.success,
      timestamp: undefined
    };

    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { toolkit_slug: null, profile_name: null, display_name: null, message: null, profile: null, success: undefined, timestamp: undefined };
};

const extractFromLegacyFormat = (content: any): Omit<CreateCredentialProfileData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};

    return {
      toolkit_slug: args.toolkit_slug || null,
      profile_name: args.profile_name || null,
      display_name: args.display_name || null,
      message: null,
      profile: null
    };
  }

  return {
    toolkit_slug: null,
    profile_name: null,
    display_name: null,
    message: null,
    profile: null
  };
};

export function extractCreateCredentialProfileData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  toolkit_slug: string | null;
  profile_name: string | null;
  display_name: string | null;
  message: string | null;
  profile: CredentialProfile | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: CreateCredentialProfileData;
  
  if (toolContent) {
    data = extractFromNewFormat(toolContent);
    if (data.success !== undefined || data.profile) {
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
    if (data.success !== undefined || data.profile) {
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
    toolkit_slug: toolLegacy.toolkit_slug || assistantLegacy.toolkit_slug,
    profile_name: toolLegacy.profile_name || assistantLegacy.profile_name,
    display_name: toolLegacy.display_name || assistantLegacy.display_name,
    message: toolLegacy.message || assistantLegacy.message,
    profile: toolLegacy.profile || assistantLegacy.profile,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  return combinedData;
} 