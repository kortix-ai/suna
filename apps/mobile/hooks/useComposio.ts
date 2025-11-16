import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { supabase } from '@/api/supabase';
import { API_URL } from '@/api/config';

interface ComposioApp {
  name: string;
  slug: string;
  logo: string;
  description: string;
  categories: string[];
  connected: boolean;
  connection_status?: 'active' | 'error' | 'requires_auth';
}

interface ComposioProfile {
  profile_id: string;
  profile_name: string;
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

interface CreateComposioProfileRequest {
  toolkit_slug: string;
  profile_name: string;
  display_name?: string;
  user_id?: string;
  mcp_server_name?: string;
  is_default?: boolean;
  initiation_fields?: Record<string, string>;
  custom_auth_config?: Record<string, string>;
  use_custom_auth?: boolean;
}

interface CreateComposioProfileResponse {
  success: boolean;
  profile_id: string;
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
  profiles: () => [...composioKeys.all, 'profiles'] as const,
  tools: (profileId: string) => [...composioKeys.all, 'tools', profileId] as const,
  toolkitDetails: (slug: string) => [...composioKeys.all, 'toolkit', slug] as const,
  toolkitTools: (slug: string) => [...composioKeys.all, 'toolkit-tools', slug] as const,
};

const useComposioApps = () => {
  return useQuery({
    queryKey: composioKeys.apps(),
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/toolkits`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
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

const useComposioProfiles = () => {
  return useQuery({
    queryKey: composioKeys.profiles(),
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/profiles`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch Composio profiles');
      }

      const data = await response.json();
      return data.profiles || [];
    },
    staleTime: 2 * 60 * 1000,
  });
};

const useComposioToolkitDetails = (slug: string) => {
  return useQuery({
    queryKey: composioKeys.toolkitDetails(slug),
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/toolkits/${slug}/details`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error('Failed to fetch toolkit details');
      }

      return response.json();
    },
    enabled: !!slug,
    staleTime: 10 * 60 * 1000,
  });
};

const useComposioTools = (profileId: string) => {
  return useQuery({
    queryKey: composioKeys.tools(profileId),
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/profiles/${profileId}/discover-tools`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to discover tools');
      }

      return response.json();
    },
    enabled: !!profileId,
    staleTime: 5 * 60 * 1000,
  });
};

const useComposioToolsBySlug = (slug: string, options?: { enabled?: boolean; limit?: number }) => {
  return useQuery({
    queryKey: [...composioKeys.toolkitTools(slug), options?.limit],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      
      const response = await fetch(`${API_URL}/composio/tools/list`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          toolkit_slug: slug,
          limit: options?.limit || 50
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

const useComposioToolkitIcon = (slug: string) => {
  return useQuery({
    queryKey: [...composioKeys.all, 'icon', slug] as const,
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${API_URL}/composio/toolkits/${slug}/icon`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
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

const useCreateComposioProfile = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CreateComposioProfileRequest) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      console.log('🔄 Creating Composio profile:', request);

      const response = await fetch(`${API_URL}/composio/profiles`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Profile creation error:', errorText);
        
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.detail || errorJson.message || 'Failed to create profile');
        } catch (parseError) {
          throw new Error(`Server error ${response.status}: ${errorText}`);
        }
      }

      const result = await response.json();
      console.log('✅ Profile created:', result);
      return result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: composioKeys.profiles() });
      queryClient.invalidateQueries({ queryKey: composioKeys.apps() });
    },
  });
};

const useCheckProfileNameAvailability = (
  toolkitSlug: string,
  profileName: string,
  options?: {
    enabled?: boolean;
    debounceMs?: number;
  }
) => {
  const [debouncedName, setDebouncedName] = useState(profileName);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedName(profileName);
    }, options?.debounceMs || 500);

    return () => clearTimeout(timer);
  }, [profileName, options?.debounceMs]);

  return useQuery({
    queryKey: ['composio', 'profile-name-availability', toolkitSlug, debouncedName],
    queryFn: async () => {
      if (!debouncedName || debouncedName.trim().length < 1) {
        return {
          available: true,
          message: '',
          suggestions: []
        };
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const params = new URLSearchParams({
        toolkit_slug: toolkitSlug,
        profile_name: debouncedName
      });

      const response = await fetch(`${API_URL}/composio/profiles/check-name-availability?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to check profile name availability');
      }

      return response.json();
    },
    enabled: options?.enabled !== false && !!toolkitSlug && !!debouncedName && debouncedName.trim().length > 0,
    staleTime: 30000,
  });
};

const useUpdateComposioTools = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      agentId, 
      profileId, 
      selectedTools 
    }: { 
      agentId: string; 
      profileId: string; 
      selectedTools: string[] 
    }) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      console.log('💾 Updating agent tools - Profile ID:', profileId, 'Agent ID:', agentId);
      console.log('🔧 Selected tools:', selectedTools);

      // First get MCP config for the profile
      const mcpConfigResponse = await fetch(`${API_URL}/composio/profiles/${profileId}/mcp-config`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!mcpConfigResponse.ok) {
        const mcpError = await mcpConfigResponse.text();
        console.error('❌ MCP Config error:', mcpError);
        throw new Error(`Failed to get MCP config: ${mcpConfigResponse.status}`);
      }

      const mcpConfig = await mcpConfigResponse.json();
      console.log('📋 MCP Config received:', mcpConfig);

      // Structure the request body to match backend expectations
      const mcpConfigData = mcpConfig.mcp_config;
      const requestBody = {
        custom_mcps: [{
          name: mcpConfigData.name,
          type: mcpConfigData.type,
          mcp_qualified_name: mcpConfigData.mcp_qualified_name,
          toolkit_slug: mcpConfigData.toolkit_slug,
          config: mcpConfigData.config,
          enabledTools: selectedTools
        }]
      };
      console.log('📤 Sending request to update tools:', JSON.stringify(requestBody, null, 2));

      // Update agent tools
      const response = await fetch(`${API_URL}/agents/${agentId}/custom-mcp-tools`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Update tools error:', errorText);
        console.error('❌ Response status:', response.status, response.statusText);
        
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
  useComposioProfiles,
  useComposioToolkitDetails,
  useComposioToolkitIcon,
  useComposioTools,
  useComposioToolsBySlug,
  useCreateComposioProfile,
  useCheckProfileNameAvailability,
  useUpdateComposioTools,
  composioKeys,
  type ComposioApp,
  type ComposioProfile,
  type ComposioTool,
  type CreateComposioProfileRequest,
  type CreateComposioProfileResponse,
  type AuthConfigField,
};
