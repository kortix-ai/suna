import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

interface MCPServer {
  qualifiedName: string;
  displayName: string;
  description: string;
  createdAt: string;
  useCount: number;
  homepage: string;
  iconUrl?: string;
  isDeployed?: boolean;
  connections?: any[];
  tools?: any[];
  security?: any;
}

interface MCPServerListResponse {
  servers: MCPServer[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
    totalCount: number;
  };
}

interface MCPServerDetailResponse {
  qualifiedName: string;
  displayName: string;
  iconUrl?: string;
  deploymentUrl?: string;
  connections: any[];
  security?: any;
  tools?: any[];
}

interface PopularServersResponse {
  success: boolean;
  servers: Array<{
    qualifiedName: string;
    displayName: string;
    description: string;
    iconUrl?: string;
    homepage?: string;
    useCount: number;
    createdAt: string;
    isDeployed: boolean;
  }>;
  categorized: Record<string, Array<{
    name: string;
    qualifiedName: string;
    description: string;
    iconUrl?: string;
    homepage?: string;
    useCount: number;
    createdAt: string;
    isDeployed: boolean;
  }>>;
  total: number;
  categoryCount: number;
  pagination: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
    totalCount: number;
  };
}

export const useMCPServers = (query?: string, page: number = 1, pageSize: number = 20) => {
  const supabase = createClient();

  return useQuery({
    queryKey: ['mcp-servers', query, page, pageSize],
    queryFn: async (): Promise<MCPServerListResponse> => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No session');

      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      });
      
      if (query) {
        params.append('q', query);
      }

      const response = await fetch(`${API_URL}/mcp/servers?${params}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch MCP servers');
      }

      return response.json();
    },
    staleTime: 5 * 60 * 1000,
  });
};

export const useMCPServerDetails = (qualifiedName: string, enabled: boolean = true) => {
  const supabase = createClient();

  return useQuery({
    queryKey: ['mcp-server-details', qualifiedName],
    queryFn: async (): Promise<MCPServerDetailResponse> => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No session');

      const response = await fetch(
        `${API_URL}/mcp/servers/${qualifiedName}`,
        {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch MCP server details');
      }

      return response.json();
    },
    enabled: enabled && !!qualifiedName,
    staleTime: 10 * 60 * 1000,
  });
};

export const usePopularMCPServers = (page: number = 1, pageSize: number = 50) => {
  const supabase = createClient();

  return useQuery({
    queryKey: ['mcp-servers-popular', page, pageSize],
    queryFn: async (): Promise<PopularServersResponse> => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No session');

      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      });

      const response = await fetch(
        `${API_URL}/mcp/popular-servers?${params}`,
        {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch popular MCP servers');
      }

      return response.json();
    },
    staleTime: 30 * 60 * 1000,
  });
}; 