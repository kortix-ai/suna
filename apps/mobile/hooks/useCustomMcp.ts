import { useMutation } from '@tanstack/react-query';
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

export {
  useDiscoverCustomMcpTools,
  type CustomMcpResponse,
};
