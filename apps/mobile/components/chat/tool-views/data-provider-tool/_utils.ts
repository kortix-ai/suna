import type { ParsedToolData } from '@/lib/utils/tool-parser';

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

export function extractDataProviderData(toolData: ParsedToolData): DataProviderData {
  const { arguments: args, result } = toolData;
  
  let provider = args?.provider || args?.data_provider || null;
  let endpoint = args?.endpoint || args?.endpoint_name || null;
  let method = args?.method || null;
  let response: any = null;
  let endpoints: any[] = [];
  
  if (result.output) {
    const parsed = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
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
    success: result.success ?? true
  };
}

