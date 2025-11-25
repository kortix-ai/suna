import { ToolCallData, ToolResultData } from '../types';

export interface CredentialProfileItem {
  profile_id: string;
  profile_name: string;
  display_name: string;
  toolkit_slug: string;
  toolkit_name: string;
  mcp_url: string;
  is_connected: boolean;
  is_default: boolean;
  created_at: string;
  updated_at?: string;
}

export interface GetCredentialProfilesData {
  toolkit_slug: string | null;
  message: string | null;
  profiles: CredentialProfileItem[];
  total_count: number;
  success?: boolean;
  timestamp?: string;
}

export function extractGetCredentialProfilesData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  toolkit_slug: string | null;
  message: string | null;
  profiles: CredentialProfileItem[];
  total_count: number;
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

  const profiles = Array.isArray(output.profiles) ? output.profiles : [];

  return {
    toolkit_slug: args.toolkit_slug || output.toolkit_slug || null,
    message: output.message || null,
    profiles,
    total_count: output.total_count || profiles.length || 0,
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
