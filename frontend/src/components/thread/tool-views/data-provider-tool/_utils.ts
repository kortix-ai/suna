import { ToolCallData, ToolResultData } from '../types';

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

export function extractDataProviderCallData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
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
  const args = toolCall.arguments || {};
  
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
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}

export function extractDataProviderEndpointsData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  serviceName: string | null;
  endpoints: any;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = toolCall.arguments || {};
  
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
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
