import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/api/supabase';
import { API_URL } from '@/api/config';

interface CustomMcpTool {
  name: string;
  description: string;
  parameters?: any;
}

interface CustomMcpConfig {
  url: string;
  type?: 'http' | 'sse';
  headers?: Record<string, string>;
}

interface CustomMcpResponse {
  success: boolean;
  tools: CustomMcpTool[];
  serverName?: string;
  processedConfig?: any;
  message?: string;
}

interface CustomMcpDiscoverRequest {
  type: string;
  config: CustomMcpConfig;
}

interface CustomMcpUpdateRequest {
  agentId: string;
  url: string;
  type: string;
  enabled_tools: string[];
  name?: string;
}

const customMcpKeys = {
  all: ['custom-mcp'] as const,
  tools: (agentId: string, url: string) => [...customMcpKeys.all, 'tools', agentId, url] as const,
  discover: (url: string, type: string) => [...customMcpKeys.all, 'discover', url, type] as const,
};

const useCustomMcpTools = (agentId: string, config: CustomMcpConfig) => {
  return useQuery({
    queryKey: customMcpKeys.tools(agentId, config.url),
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        'X-MCP-URL': config.url,
        'X-MCP-Type': config.type || 'http',
      };

      if (config.headers) {
        headers['X-MCP-Headers'] = JSON.stringify(config.headers);
      }

      const response = await fetch(`${API_URL}/agents/${agentId}/custom-mcp-tools`, {
        headers,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to fetch custom MCP tools');
      }

      return response.json();
    },
    enabled: !!agentId && !!config.url,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

const useDiscoverCustomMcpTools = () => {
  return useMutation({
    mutationFn: async (request: CustomMcpDiscoverRequest): Promise<CustomMcpResponse> => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/mcp/discover-custom-tools`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || error.message || 'Failed to discover custom MCP tools');
      }

      return response.json();
    },
  });
};

const useUpdateCustomMcpTools = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CustomMcpUpdateRequest) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const { agentId, ...body } = request;

      const response = await fetch(`${API_URL}/agents/${agentId}/custom-mcp-tools`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to update custom MCP tools');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ 
        queryKey: customMcpKeys.tools(variables.agentId, variables.url) 
      });
      queryClient.invalidateQueries({ 
        queryKey: ['agents', 'detail', variables.agentId] 
      });
      queryClient.invalidateQueries({ 
        queryKey: ['agent-tools', variables.agentId] 
      });
    },
  });
};

export {
  useCustomMcpTools,
  useDiscoverCustomMcpTools,
  useUpdateCustomMcpTools,
  customMcpKeys,
  type CustomMcpTool,
  type CustomMcpConfig,
  type CustomMcpResponse,
  type CustomMcpDiscoverRequest,
  type CustomMcpUpdateRequest,
};
