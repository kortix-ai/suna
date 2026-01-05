import { ToolCallData, ToolResultData } from '../types';

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

export function extractConnectCredentialProfileData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
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
    profile_id: args.profile_id || output.profile_id || null,
    message: output.message || null,
    profile_name: args.profile_name || output.profile_name || null,
    app_name: args.app_name || output.app_name || null,
    app_slug: args.app_slug || output.app_slug || null,
    connection_link: output.connection_link || null,
    external_user_id: args.external_user_id || output.external_user_id || null,
    expires_at: output.expires_at || null,
    instructions: output.instructions || null,
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
