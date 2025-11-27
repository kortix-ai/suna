import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface DataProviderData {
  provider: string | null;
  endpoint: string | null;
  method: string | null;
  response: any;
  endpoints: any[];
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

export function extractDataProviderData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): DataProviderData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};
  
  let provider = args?.provider || args?.data_provider || null;
  let endpoint = args?.endpoint || args?.endpoint_name || null;
  let method = args?.method || null;
  let response: any = null;
  let endpoints: any[] = [];
  
  if (toolResult?.output) {
    const parsed = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (Array.isArray(parsed)) {
      endpoints = parsed;
    } else if (parsed && typeof parsed === 'object') {
      if (parsed.endpoints && Array.isArray(parsed.endpoints)) {
        endpoints = parsed.endpoints;
      }
      if (parsed.response !== undefined) {
        response = parsed.response;
      } else if (parsed.data !== undefined) {
        response = parsed.data;
      } else {
        response = parsed;
      }
    } else {
      response = parsed;
    }
  }
  
  return {
    provider,
    endpoint,
    method,
    response,
    endpoints,
    success: toolResult?.success ?? true
  };
}

export interface DataProviderEndpointsData {
  serviceName: string | null;
  endpoints: any;
  success: boolean;
}

export function extractDataProviderEndpointsData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): DataProviderEndpointsData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};
  
  let output: any = {};
  if (toolResult?.output) {
    if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = toolResult.output;
    } else if (typeof toolResult.output === 'string') {
      try {
        output = JSON.parse(toolResult.output);
      } catch (e) {
        // Not JSON, ignore
      }
    }
  }

  return {
    serviceName: args.service_name || args.serviceName || null,
    endpoints: output.endpoints || null,
    success: toolResult?.success ?? true
  };
}

export interface DataProviderCallData {
  serviceName: string | null;
  route: string | null;
  payload: any;
  output: string | null;
  success: boolean;
}

export function extractDataProviderCallData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): DataProviderCallData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};
  
  let output: any = null;
  if (toolResult?.output) {
    if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = typeof toolResult.output.output === 'string' 
        ? toolResult.output.output 
        : JSON.stringify(toolResult.output, null, 2);
    } else if (typeof toolResult.output === 'string') {
      output = toolResult.output;
    }
  }

  return {
    serviceName: args.service_name || args.serviceName || null,
    route: args.route || null,
    payload: args.payload || null,
    output,
    success: toolResult?.success ?? true
  };
}

