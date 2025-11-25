import { ToolCallData, ToolResultData } from '../types';

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

export function extractCreateCredentialProfileData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
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
    profile_name: args.profile_name || output.profile_name || null,
    display_name: args.display_name || output.display_name || null,
    message: output.message || null,
    profile: output.profile || null,
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
