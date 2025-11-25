import { ToolCallData, ToolResultData } from '../types';

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

export function extractGetAppDetailsData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
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
    toolkit_slug: args.toolkit_slug || output.toolkit_slug || null,
    message: output.message || null,
    toolkit: output.toolkit || null,
    supports_oauth: output.supports_oauth || false,
    auth_schemes: Array.isArray(output.auth_schemes) ? output.auth_schemes : [],
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
