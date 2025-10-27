import type { ParsedToolData } from '@/lib/utils/tool-parser';

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

export function extractMcpServerData(toolData: ParsedToolData): McpServerData {
  const { arguments: args, result } = toolData;
  
  let query = args?.query || null;
  let servers: McpServer[] = [];
  let server: McpServer | undefined;
  let message: string | undefined;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
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
    success: result.success ?? true
  };
}

export function getPrimaryAuthScheme(authSchemes: string[]): string {
  if (authSchemes?.includes('OAUTH2')) return 'OAuth2';
  if (authSchemes?.includes('API_KEY')) return 'API Key';
  if (authSchemes?.includes('BEARER_TOKEN')) return 'Bearer Token';
  return authSchemes?.[0] || 'None';
}

