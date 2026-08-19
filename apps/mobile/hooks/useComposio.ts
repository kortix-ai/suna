import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { supabase } from '@/api/supabase';
import { API_URL } from '@/api/config';
import { log } from '@/lib/logger';

interface ComposioApp {
  name: string;
  slug: string;
  logo: string;
  description: string;
  categories: string[];
  connected: boolean;
  connection_status?: 'active' | 'error' | 'requires_auth';
}

interface ComposioConnection {
  connection_id: string;
  connection_name: string;
  display_name: string;
  toolkit_name: string;
  toolkit_slug: string;
  mcp_url: string;
  redirect_url?: string;
  connected_account_id?: string;
  is_connected: boolean;
  is_default: boolean;
  connection_status: 'active' | 'error' | 'requires_auth';
  created_at: string;
}

interface ComposioTool {
  name: string;
  slug: string;
  description: string;
  parameters?: any;
  tags?: string[];
}

interface CreateComposioConnectionRequest {
  toolkit_slug: string;
  connection_name: string;
  display_name?: string;
  user_id?: string;
  mcp_server_name?: string;
  is_default?: boolean;
  initiation_fields?: Record<string, string>;
  custom_auth_config?: Record<string, string>;
  use_custom_auth?: boolean;
}

interface CreateComposioConnectionResponse {
  success: boolean;
  connection_id: string;
  redirect_url?: string;
  mcp_url: string;
}

interface AuthConfigField {
  name: string;
  displayName: string;
  type: string;
  required: boolean;
  description?: string;
  default?: string;
}

const composioKeys = {
  all: ['composio'] as const,
  apps: () => [...composioKeys.all, 'apps'] as const,
  connections: () => [...composioKeys.all, 'connections'] as const,
  tools: (connectionId: string) => [...composioKeys.all, 'tools', connectionId] as const,
  toolkitDetails: (slug: string) => [...composioKeys.all, 'toolkit', slug] as const,
  toolkitTools: (slug: string) => [...composioKeys.all, 'toolkit-tools', slug] as const,
};

const SENSITIVE_LOG_KEY_RE = /secret|token|password|key|auth_config|mcp_url|config/i;

type ComposioConnectionWire = Omit<ComposioConnection, 'connection_name'> & {
  connection_name?: string;
  /** Legacy Composio API field. */
  profile_name?: string;
};

function normalizeComposioConnection(value: ComposioConnectionWire): ComposioConnection {
  return {
    ...value,
    connection_name: value.connection_name ?? value.profile_name ?? value.display_name,
  };
}

function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_LOG_KEY_RE.test(key) ? '[redacted]' : redactForLog(entry);
  }
  return result;
}

const useComposioApps = () => {
  return useQuery({
    queryKey: composioKeys.apps(),
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/toolkits`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch Composio apps');
      }

      return response.json();
    },
    staleTime: 5 * 60 * 1000,
  });
};

const useComposioConnections = () => {
  return useQuery({
    queryKey: composioKeys.connections(),
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/profiles`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch Composio connections');
      }

      const data = await response.json();
      return (data.connections ?? data.profiles ?? []).map(normalizeComposioConnection);
    },
    staleTime: 2 * 60 * 1000,
  });
};

const useComposioToolkitDetails = (slug: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: composioKeys.toolkitDetails(slug),
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/toolkits/${slug}/details`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error('Failed to fetch toolkit details');
      }

      return response.json();
    },
    enabled: options?.enabled !== false && !!slug,
    staleTime: 10 * 60 * 1000,
  });
};

const useComposioTools = (connectionId: string) => {
  return useQuery({
    queryKey: composioKeys.tools(connectionId),
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/profiles/${connectionId}/discover-tools`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to discover tools');
      }

      return response.json();
    },
    enabled: !!connectionId,
    staleTime: 5 * 60 * 1000,
  });
};

const useComposioToolsBySlug = (slug: string, options?: { enabled?: boolean; limit?: number }) => {
  return useQuery({
    queryKey: [...composioKeys.toolkitTools(slug), options?.limit],
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/tools/list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          toolkit_slug: slug,
          limit: options?.limit || 50,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to fetch toolkit tools');
      }

      return response.json();
    },
    enabled: options?.enabled !== false && !!slug,
    staleTime: 10 * 60 * 1000,
  });
};

const useComposioToolsBySlugInfinite = (
  slug: string,
  options?: { enabled?: boolean; limit?: number }
) => {
  return useInfiniteQuery({
    queryKey: [...composioKeys.toolkitTools(slug), 'infinite', options?.limit],
    queryFn: async ({ pageParam }) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/tools/list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          toolkit_slug: slug,
          limit: options?.limit || 50,
          cursor: pageParam,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to fetch toolkit tools');
      }

      return response.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      return lastPage.next_cursor || undefined;
    },
    enabled: options?.enabled !== false && !!slug,
    staleTime: 10 * 60 * 1000,
  });
};

const useComposioToolkitIcon = (slug: string) => {
  return useQuery({
    queryKey: [...composioKeys.all, 'icon', slug] as const,
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/toolkits/${slug}/icon`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch toolkit icon');
      }

      return response.json();
    },
    enabled: !!slug,
    staleTime: 30 * 60 * 1000,
  });
};

const useCreateComposioConnection = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CreateComposioConnectionRequest) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      log.log('🔄 Creating Composio connection:', redactForLog(request));

      const response = await fetch(`${API_URL}/composio/profiles`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...request,
          profile_name: request.connection_name,
          connection_name: undefined,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log.error('❌ Connection creation error:', errorText);

        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.detail || errorJson.message || 'Failed to create connection');
        } catch (parseError) {
          throw new Error(`Server error ${response.status}: ${errorText}`);
        }
      }

      const result = await response.json();
      log.log('✅ Connection created:', redactForLog(result));
      return result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: composioKeys.connections() });
      queryClient.invalidateQueries({ queryKey: composioKeys.apps() });
    },
  });
};

const useCheckConnectionNameAvailability = (
  toolkitSlug: string,
  connectionName: string,
  options?: {
    enabled?: boolean;
    debounceMs?: number;
  }
) => {
  const [debouncedName, setDebouncedName] = useState(connectionName);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedName(connectionName);
    }, options?.debounceMs || 500);

    return () => clearTimeout(timer);
  }, [connectionName, options?.debounceMs]);

  return useQuery({
    queryKey: ['composio', 'connection-name-availability', toolkitSlug, debouncedName],
    queryFn: async () => {
      if (!debouncedName || debouncedName.trim().length < 1) {
        return {
          available: true,
          message: '',
          suggestions: [],
        };
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const params = new URLSearchParams({
        toolkit_slug: toolkitSlug,
        // Legacy Composio API query field.
        profile_name: debouncedName,
      });

      const response = await fetch(
        `${API_URL}/composio/profiles/check-name-availability?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to check connection name availability');
      }

      return response.json();
    },
    enabled:
      options?.enabled !== false &&
      !!toolkitSlug &&
      !!debouncedName &&
      debouncedName.trim().length > 0,
    staleTime: 30000,
  });
};

const useUpdateComposioTools = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      connectionId,
      selectedTools,
    }: {
      agentId: string;
      connectionId: string;
      selectedTools: string[];
    }) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      log.log('💾 Updating agent tools - Connection ID:', connectionId, 'Agent ID:', agentId);
      log.log('🔧 Selected tools:', selectedTools);

      // First get MCP config for the connection.
      const mcpConfigResponse = await fetch(
        `${API_URL}/composio/profiles/${connectionId}/mcp-config`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!mcpConfigResponse.ok) {
        const mcpError = await mcpConfigResponse.text();
        log.error('❌ MCP Config error:', mcpError);
        throw new Error(`Failed to get MCP config: ${mcpConfigResponse.status}`);
      }

      const mcpConfig = await mcpConfigResponse.json();
      log.log('📋 MCP Config received:', redactForLog(mcpConfig));

      // Structure the request body to match backend expectations
      const mcpConfigData = mcpConfig.mcp_config;
      const requestBody = {
        custom_mcps: [
          {
            name: mcpConfigData.name,
            type: mcpConfigData.type,
            mcp_qualified_name: mcpConfigData.mcp_qualified_name,
            toolkit_slug: mcpConfigData.toolkit_slug,
            config: mcpConfigData.config,
            enabledTools: selectedTools,
          },
        ],
      };
      log.log('📤 Sending request to update tools:', redactForLog(requestBody));

      // Update agent tools
      const response = await fetch(`${API_URL}/agents/${agentId}/custom-mcp-tools`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log.error('❌ Update tools error:', errorText);
        log.error('❌ Response status:', response.status, response.statusText);

        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.detail || errorJson.message || 'Failed to update tools');
        } catch (parseError) {
          throw new Error(`Server error ${response.status}: ${errorText}`);
        }
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents', 'detail', variables.agentId] });
      queryClient.invalidateQueries({ queryKey: ['agent-tools', variables.agentId] });
    },
  });
};

export {
  useComposioApps,
  useComposioConnections,
  useComposioToolkitDetails,
  useComposioToolkitIcon,
  useComposioTools,
  useComposioToolsBySlug,
  useComposioToolsBySlugInfinite,
  useCreateComposioConnection,
  useCheckConnectionNameAvailability,
  useUpdateComposioTools,
  composioKeys,
  type ComposioApp,
  type ComposioConnection,
  type ComposioTool,
  type CreateComposioConnectionRequest,
  type CreateComposioConnectionResponse,
  type AuthConfigField,
};
