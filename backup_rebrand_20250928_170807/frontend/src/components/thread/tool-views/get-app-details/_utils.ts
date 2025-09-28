import { extractToolData } from '../utils';

export interface ToolkitDetails {
  name: string;
  toolkit_slug: string;
  description: string;
  logo_url: string;
  auth_schemes: string[];
  tags?: string[];
  categories?: string[];
}

export interface GetAppDetailsData {
  toolkit_slug: string | null;
  message: string | null;
  toolkit: ToolkitDetails | null;
  supports_oauth: boolean;
  auth_schemes: string[];
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

const extractFromNewFormat = (content: any): GetAppDetailsData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { toolkit_slug: null, message: null, toolkit: null, supports_oauth: false, auth_schemes: [], success: undefined, timestamp: undefined };
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
      message: parsedOutput.message || null,
      toolkit: parsedOutput.toolkit || null,
      supports_oauth: parsedOutput.supports_oauth || false,
      auth_schemes: parsedOutput.auth_schemes || [],
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };

    return extractedData;
  }

  if ('parameters' in parsedContent && 'output' in parsedContent) {
    const extractedData = {
      toolkit_slug: parsedContent.parameters?.toolkit_slug || null,
      message: parsedContent.output?.message || null,
      toolkit: parsedContent.output?.toolkit || null,
      supports_oauth: parsedContent.output?.supports_oauth || false,
      auth_schemes: parsedContent.output?.auth_schemes || [],
      success: parsedContent.success,
      timestamp: undefined
    };

    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { toolkit_slug: null, message: null, toolkit: null, supports_oauth: false, auth_schemes: [], success: undefined, timestamp: undefined };
};

const extractFromLegacyFormat = (content: any): Omit<GetAppDetailsData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    
    return {
      toolkit_slug: args.toolkit_slug || null,
      message: null,
      toolkit: null,
      supports_oauth: false,
      auth_schemes: []
    };
  }

  return {
    toolkit_slug: null,
    message: null,
    toolkit: null,
    supports_oauth: false,
    auth_schemes: []
  };
};

export function extractGetAppDetailsData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  toolkit_slug: string | null;
  message: string | null;
  toolkit: ToolkitDetails | null;
  supports_oauth: boolean;
  auth_schemes: string[];
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let data: GetAppDetailsData;
  
  if (toolContent) {
    data = extractFromNewFormat(toolContent);
    if (data.success !== undefined || data.toolkit) {
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
    if (data.success !== undefined || data.toolkit) {
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
    message: toolLegacy.message || assistantLegacy.message,
    toolkit: toolLegacy.toolkit || assistantLegacy.toolkit,
    supports_oauth: toolLegacy.supports_oauth || assistantLegacy.supports_oauth,
    auth_schemes: toolLegacy.auth_schemes.length > 0 ? toolLegacy.auth_schemes : assistantLegacy.auth_schemes,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  return combinedData;
} 