import { ToolCallData, ToolResultData } from '../types';

export interface Connection {
  external_user_id: string;
  app_slug: string;
  app_name: string;
  created_at: string;
  updated_at: string;
  is_active: boolean;
}

export interface CheckProfileConnectionData {
  profile_id: string | null;
  profile_name: string | null;
  app_name: string | null;
  app_slug: string | null;
  external_user_id: string | null;
  is_connected: boolean;
  connections: Connection[];
  connection_count: number;
  available_tools: string[];
  tool_count: number;
  message: string | null;
  success?: boolean;
  timestamp?: string;
}

export function extractCheckProfileConnectionData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  profile_id: string | null;
  profile_name: string | null;
  app_name: string | null;
  app_slug: string | null;
  external_user_id: string | null;
  is_connected: boolean;
  connections: Connection[];
  connection_count: number;
  available_tools: string[];
  tool_count: number;
  message: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  // Extract from toolCall.arguments
  const args = toolCall.arguments || {};
  
  // Extract from toolResult.output
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

  const connections = Array.isArray(output.connections) ? output.connections : [];
  const available_tools = Array.isArray(output.available_tools) ? output.available_tools : [];

  return {
    profile_id: args.profile_id || output.profile_id || null,
    profile_name: args.profile_name || output.profile_name || null,
    app_name: args.app_name || output.app_name || null,
    app_slug: args.app_slug || output.app_slug || null,
    external_user_id: args.external_user_id || output.external_user_id || null,
    is_connected: output.is_connected || false,
    connections,
    connection_count: output.connection_count || connections.length || 0,
    available_tools,
    tool_count: output.tool_count || available_tools.length || 0,
    message: output.message || null,
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
