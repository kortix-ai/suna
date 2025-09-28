import { extractToolData, normalizeContentToString } from '../utils';

export interface DataProviderCallData {
  serviceName: string | null;
  route: string | null;
  payload: any;
  success?: boolean;
  timestamp?: string;
  output?: string;
}

export interface DataProviderEndpointsData {
  serviceName: string | null;
  endpoints: any;
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

const extractFromNewFormat = (content: any): { 
  serviceName: string | null; 
  route: string | null; 
  payload: any; 
  endpoints: any;
  success?: boolean; 
  timestamp?: string;
  output?: string;
} => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { serviceName: null, route: null, payload: null, endpoints: null, success: undefined, timestamp: undefined, output: undefined };
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

    const extractedData = {
      serviceName: args.service_name || null,
      route: args.route || null,
      payload: args.payload || args,
      endpoints: parsedOutput || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp,
      output: typeof toolExecution.result?.output === 'string' ? toolExecution.result.output : null
    };

    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { serviceName: null, route: null, payload: null, endpoints: null, success: undefined, timestamp: undefined, output: undefined };
};

const parseDataProviderCall = (message: string) => {
  const tagRegex = /<execute-data-provider-call\b(?=[^>]*\bservice_name="([^"]+)")(?=[^>]*\broute="([^"]+)")[^>]*>/;
  const tagMatch = message.match(tagRegex);

  let serviceName = null;
  let route = null;

  if (tagMatch) {
    serviceName = tagMatch[1];
    route = tagMatch[2];
  }

  const contentRegex = /<execute-data-provider-call\b[^>]*>\s*(\{[\s\S]*?\})\s*<\/execute-data-provider-call>/;
  const contentMatch = message.match(contentRegex);

  let jsonContent = null;
  if (contentMatch) {
    let jsonString = contentMatch[1].trim();
    jsonString = jsonString.replace(/\\"/g, '"');
    try {
      jsonContent = JSON.parse(jsonString);
    } catch (e) {
      console.error('Failed to parse JSON content:', e);
      console.error('JSON string was:', jsonString);
      jsonContent = jsonString;
    }
  }

  return { serviceName, route, jsonContent };
};

const extractServiceName = (message: string): string | null => {
  const regex = /<get-data-provider-endpoints\s+service_name="([^"]+)"\s*>/;
  const match = message.match(regex);
  return match ? match[1] : null;
};

const extractFromLegacyFormat = (content: any): { 
  serviceName: string | null; 
  route: string | null; 
  payload: any; 
  endpoints: any;
} => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult && toolData.arguments) {
    return {
      serviceName: toolData.arguments.service_name || null,
      route: toolData.arguments.route || null,
      payload: toolData.arguments,
      endpoints: null
    };
  }

  const contentStr = normalizeContentToString(content);
  if (!contentStr) {
    return { serviceName: null, route: null, payload: null, endpoints: null };
  }

  const parsed = parseDataProviderCall(contentStr);
  if (parsed.serviceName || parsed.route) {
    return {
      serviceName: parsed.serviceName,
      route: parsed.route,
      payload: parsed.jsonContent,
      endpoints: null
    };
  }

  const serviceName = extractServiceName(contentStr);
  if (serviceName) {
    return {
      serviceName,
      route: null,
      payload: null,
      endpoints: null
    };
  }

  return { serviceName: null, route: null, payload: null, endpoints: null };
};

export function extractDataProviderCallData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  serviceName: string | null;
  route: string | null;
  payload: any;
  output: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let serviceName: string | null = null;
  let route: string | null = null;
  let payload: any = null;
  let output: string | null = null;
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.serviceName || assistantNewFormat.route) {
    serviceName = assistantNewFormat.serviceName;
    route = assistantNewFormat.route;
    payload = assistantNewFormat.payload;
    output = assistantNewFormat.output ?? null;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.serviceName || toolNewFormat.route) {
    serviceName = toolNewFormat.serviceName;
    route = toolNewFormat.route;
    payload = toolNewFormat.payload;
    output = toolNewFormat.output ?? null;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    serviceName = assistantLegacy.serviceName || toolLegacy.serviceName;
    route = assistantLegacy.route || toolLegacy.route;
    payload = assistantLegacy.payload || toolLegacy.payload;
  }

  return {
    serviceName,
    route,
    payload,
    output,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}

export function extractDataProviderEndpointsData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  serviceName: string | null;
  endpoints: any;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let serviceName: string | null = null;
  let endpoints: any = null;
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.serviceName || assistantNewFormat.endpoints) {
    serviceName = assistantNewFormat.serviceName;
    endpoints = assistantNewFormat.endpoints;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.serviceName || toolNewFormat.endpoints) {
    serviceName = toolNewFormat.serviceName;
    endpoints = toolNewFormat.endpoints;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    serviceName = assistantLegacy.serviceName || toolLegacy.serviceName;
    endpoints = assistantLegacy.endpoints || toolLegacy.endpoints;

    if (!serviceName) {
      const extractProviderName = (content: string | object | undefined | null): string => {
        const contentStr = normalizeContentToString(content);
        const detectedServiceName = extractServiceName(contentStr || '');
        if (detectedServiceName) {
          return detectedServiceName.toLowerCase();
        }

        if (!contentStr) return 'linkedin';

        const content_lower = contentStr.toLowerCase();
        
        if (content_lower.includes('linkedin')) return 'linkedin';
        if (content_lower.includes('twitter')) return 'twitter';
        if (content_lower.includes('zillow')) return 'zillow';
        if (content_lower.includes('amazon')) return 'amazon';
        if (content_lower.includes('yahoo') || content_lower.includes('finance')) return 'yahoo_finance';
        if (content_lower.includes('jobs') || content_lower.includes('active')) return 'active_jobs';
        
        return 'linkedin';
      };

      serviceName = extractProviderName(assistantContent || toolContent);
    }
  }

  return {
    serviceName,
    endpoints,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
} 