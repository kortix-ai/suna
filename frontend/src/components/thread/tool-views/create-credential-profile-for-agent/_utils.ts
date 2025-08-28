import { parseToolResult } from '../tool-result-parser';

export interface CreateCredentialProfileData {
  toolkit_slug: string | null;
  profile_name: string | null;
  authentication_url: string | null;
  toolkit_name: string | null;
  requires_authentication: boolean;
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

export function extractCreateCredentialProfileData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CreateCredentialProfileData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: CreateCredentialProfileData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    toolkit_slug: null,
    profile_name: null,
    authentication_url: null,
    toolkit_name: null,
    requires_authentication: false,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  if (toolContent) {
    const parsedToolResult = parseToolResult(toolContent);
    
    if (parsedToolResult && parsedToolResult.functionName === 'create_credential_profile_for_agent') {
      const args = parsedToolResult.arguments || {};
      
      let output: any = {};
      try {
        if (typeof parsedToolResult.toolOutput === 'string') {
          output = JSON.parse(parsedToolResult.toolOutput);
        } else if (typeof parsedToolResult.toolOutput === 'object') {
          output = parsedToolResult.toolOutput;
        }
      } catch (e) {
        const content = parseContent(toolContent);
        if (content?.tool_execution?.result?.output) {
          output = content.tool_execution.result.output;
        }
      }

      return {
        toolkit_slug: args.toolkit_slug || output.toolkit_slug || null,
        profile_name: args.profile_name || output.profile_name || null,
        authentication_url: output.authentication_url || null,
        toolkit_name: output.toolkit_name || null,
        requires_authentication: output.requires_authentication || false,
        success: parsedToolResult.isSuccess,
        timestamp: parsedToolResult.timestamp,
        actualIsSuccess: parsedToolResult.isSuccess,
        actualToolTimestamp: parsedToolResult.timestamp || toolTimestamp,
        actualAssistantTimestamp: assistantTimestamp
      };
    }
  }

  if (assistantContent) {
    const parsedToolResult = parseToolResult(assistantContent);
    
    if (parsedToolResult && parsedToolResult.functionName === 'create_credential_profile_for_agent') {
      const args = parsedToolResult.arguments || {};
      let output: any = {};
      try {
        if (typeof parsedToolResult.toolOutput === 'string') {
          output = JSON.parse(parsedToolResult.toolOutput);
        } else if (typeof parsedToolResult.toolOutput === 'object') {
          output = parsedToolResult.toolOutput;
        }
      } catch (e) {
        const content = parseContent(assistantContent);
        if (content?.tool_execution?.result?.output) {
          output = content.tool_execution.result.output;
        }
      }

      return {
        toolkit_slug: args.toolkit_slug || output.toolkit_slug || null,
        profile_name: args.profile_name || output.profile_name || null,
        authentication_url: output.authentication_url || null,
        toolkit_name: output.toolkit_name || null,
        requires_authentication: output.requires_authentication || false,
        success: parsedToolResult.isSuccess,
        timestamp: parsedToolResult.timestamp,
        actualIsSuccess: parsedToolResult.isSuccess,
        actualToolTimestamp: toolTimestamp,
        actualAssistantTimestamp: parsedToolResult.timestamp || assistantTimestamp
      };
    }
  }

  return defaultResult;
} 