import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface McpServer {
  name: string;
  toolkit_slug: string;
  description: string;
  logo_url?: string;
  auth_schemes: string[];
  tags?: string[];
}

export interface McpServerData {
  query: string | null;
  servers: McpServer[];
  server?: McpServer;
  message?: string;
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

export function extractMcpServerData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): McpServerData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let query = args?.query || null;
  let servers: McpServer[] = [];
  let server: McpServer | undefined;
  let message: string | undefined;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (Array.isArray(output)) {
      servers = output.map((s: any) => ({
        name: s.name || '',
        toolkit_slug: s.toolkit_slug || s.slug || '',
        description: s.description || '',
        logo_url: s.logo_url,
        auth_schemes: s.auth_schemes || [],
        tags: s.tags || s.categories || []
      }));
    } else if (output && typeof output === 'object') {
      if (output.servers && Array.isArray(output.servers)) {
        servers = output.servers;
      } else if (output.server) {
        server = output.server;
      }
      message = output.message;
    }
  }
  
  return {
    query,
    servers,
    server,
    message,
    success: toolResult?.success ?? true
  };
}

export function getPrimaryAuthScheme(authSchemes: string[]): string {
  if (authSchemes?.includes('OAUTH2')) return 'OAuth2';
  if (authSchemes?.includes('API_KEY')) return 'API Key';
  if (authSchemes?.includes('BEARER_TOKEN')) return 'Bearer Token';
  return authSchemes?.[0] || 'None';
}

