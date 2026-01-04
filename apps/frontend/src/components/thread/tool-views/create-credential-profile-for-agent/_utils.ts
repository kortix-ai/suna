import { ToolCallData, ToolResultData } from '../types';

export interface CreateCredentialProfileData {
  toolkit_slug: string | null;
  profile_name: string | null;
  authentication_url: string | null;
  toolkit_name: string | null;
  requires_authentication: boolean;
  success?: boolean;
  timestamp?: string;
}

export function extractCreateCredentialProfileData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CreateCredentialProfileData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: CreateCredentialProfileData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    toolkit_slug: null,
    profile_name: null,
    authentication_url: null,
    toolkit_name: null,
    requires_authentication: false,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  if (!toolResult?.output) {
    return defaultResult;
  }

  let parsedOutput: any = toolResult.output;
  if (typeof parsedOutput === 'string') {
    try {
      parsedOutput = JSON.parse(parsedOutput);
    } catch (e) {
      return { ...defaultResult, actualIsSuccess: false };
    }
  }

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

  return {
    toolkit_slug: parsedOutput.toolkit_slug || args.toolkit_slug || null,
    profile_name: parsedOutput.profile_name || args.profile_name || null,
    authentication_url: parsedOutput.authentication_url || null,
    toolkit_name: parsedOutput.toolkit_name || null,
    requires_authentication: parsedOutput.requires_authentication ?? false,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
