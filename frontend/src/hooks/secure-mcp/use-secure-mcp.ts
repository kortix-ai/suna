import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export interface MCPCredential {
  credential_id: string;
  mcp_qualified_name: string;
  display_name: string;
  config_keys: string[];
  is_active: boolean;
  last_used_at?: string;
  created_at: string;
  updated_at: string;
}

export interface StoreCredentialRequest {
  mcp_qualified_name: string;
  display_name: string;
  config: Record<string, any>;
}

export interface TestCredentialResponse {
  success: boolean;
  message: string;
  error_details?: string;
}

export interface UsageExampleMessage {
  role: 'user' | 'assistant';
  content: string;
  tool_calls?: Array<{
    name: string;
    arguments?: Record<string, any>;
  }>;
}

export interface AgentTemplate {
  template_id: string;
  creator_id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  mcp_requirements: MCPRequirement[];
  agentpress_tools: Record<string, any>;
  tags: string[];
  categories: string[];
  is_public: boolean;
  download_count: number;
  marketplace_published_at?: string;
  created_at: string;
  creator_name?: string;
  icon_name?: string;
  icon_color?: string;
  icon_background?: string;
  is_kortix_team?: boolean;
  usage_examples?: UsageExampleMessage[];
  metadata?: {
    source_agent_id?: string;
    source_version_id?: string;
    source_version_name?: string;
    model?: string;
  };
  config?: {
    triggers?: Array<{
      name: string;
      description?: string;
      trigger_type: string;
      is_active: boolean;
      config: Record<string, any>;
    }>;
  };
}

export interface MCPRequirement {
  qualified_name: string;
  display_name: string;
  enabled_tools: string[];
  required_config: string[];
  custom_type?: 'sse' | 'http';
}

export interface InstallTemplateRequest {
  template_id: string;
  instance_name?: string;
  custom_system_prompt?: string;
  profile_mappings?: Record<string, string>;
  custom_mcp_configs?: Record<string, Record<string, any>>;
  trigger_configs?: Record<string, Record<string, any>>;
  trigger_variables?: Record<string, Record<string, string>>;
}

export interface InstallationResponse {
  status: 'installed' | 'configs_required';
  instance_id?: string;
  name?: string;
  missing_regular_credentials?: {
    qualified_name: string;
    display_name: string;
    required_config: string[];
  }[];
  missing_custom_configs?: {
    qualified_name: string;
    display_name: string;
    custom_type: string;
    required_config: string[];
  }[];
  missing_trigger_variables?: Record<string, {
    trigger_name: string;
    trigger_index: number;
    variables: string[];
    agent_prompt: string;
    missing_variables?: string[];
  }>;
  template?: {
    template_id: string;
    name: string;
    description?: string;
  };
}

export interface CreateTemplateRequest {
  agent_id: string;
  make_public?: boolean;
  tags?: string[];
  usage_examples?: UsageExampleMessage[];
}

export function useUserCredentials() {
  return useQuery({
    queryKey: ['secure-mcp', 'credentials'],
    queryFn: async (): Promise<MCPCredential[]> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to view credentials');
      }

      const response = await fetch(`${API_URL}/secure-mcp/credentials`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
  });
}

export function useStoreCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: StoreCredentialRequest): Promise<MCPCredential> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to store credentials');
      }

      const response = await fetch(`${API_URL}/secure-mcp/credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'credentials'] });
    },
  });
}

export function useDeleteCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (mcp_qualified_name: string): Promise<void> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to delete credentials');
      }

      const response = await fetch(`${API_URL}/secure-mcp/credentials/${encodeURIComponent(mcp_qualified_name)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'credentials'] });
    },
  });
}

export interface MarketplacePaginationInfo {
  current_page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
}

export interface MarketplaceTemplatesResponse {
  templates: AgentTemplate[];
  pagination: MarketplacePaginationInfo;
}

export function useMarketplaceTemplates(params?: {
  page?: number;
  limit?: number;
  search?: string;
  tags?: string;
  is_kortix_team?: boolean;
  mine?: boolean;
  sort_by?: string;
  sort_order?: string;
}) {
  return useQuery({
    queryKey: ['secure-mcp', 'marketplace-templates', params],
    queryFn: async (): Promise<MarketplaceTemplatesResponse> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to view marketplace templates');
      }

      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', params.page.toString());
      if (params?.limit) searchParams.set('limit', params.limit.toString());
      if (params?.search) searchParams.set('search', params.search);
      if (params?.tags) searchParams.set('tags', params.tags);
      if (params?.is_kortix_team !== undefined) searchParams.set('is_kortix_team', params.is_kortix_team.toString());
      if (params?.mine !== undefined) searchParams.set('mine', params.mine.toString());
      if (params?.sort_by) searchParams.set('sort_by', params.sort_by);
      if (params?.sort_order) searchParams.set('sort_order', params.sort_order);

      const response = await fetch(`${API_URL}/templates/marketplace?${searchParams}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    },
  });
}

export function useTemplateDetails(template_id: string) {
  return useQuery({
    queryKey: ['secure-mcp', 'template', template_id],
    queryFn: async (): Promise<AgentTemplate> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to view template details');
      }

      const response = await fetch(`${API_URL}/templates/${template_id}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    enabled: !!template_id,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CreateTemplateRequest): Promise<{ template_id: string; message: string }> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to create templates');
      }

      const response = await fetch(`${API_URL}/templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'marketplace-templates'] });
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'my-templates'] });
    },
  });
}

export function useMyTemplates(params?: {
  page?: number;
  limit?: number;
  search?: string;
  sort_by?: string;
  sort_order?: string;
}) {
  return useQuery({
    queryKey: ['secure-mcp', 'my-templates', params],
    queryFn: async (): Promise<MarketplaceTemplatesResponse> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to view your templates');
      }

      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', params.page.toString());
      if (params?.limit) searchParams.set('limit', params.limit.toString());
      if (params?.search) searchParams.set('search', params.search);
      if (params?.sort_by) searchParams.set('sort_by', params.sort_by);
      if (params?.sort_order) searchParams.set('sort_order', params.sort_order);

      const response = await fetch(`${API_URL}/templates/my?${searchParams}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
  });
}

export function usePublishTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      template_id, 
      tags,
      usage_examples 
    }: { 
      template_id: string; 
      tags?: string[];
      usage_examples?: UsageExampleMessage[];
    }): Promise<{ message: string }> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to publish templates');
      }

      const response = await fetch(`${API_URL}/templates/${template_id}/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ tags, usage_examples }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'marketplace-templates'] });
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'my-templates'] });
    },
  });
}

export function useUnpublishTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (template_id: string): Promise<{ message: string }> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to unpublish templates');
      }

      const response = await fetch(`${API_URL}/templates/${template_id}/unpublish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'marketplace-templates'] });
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'my-templates'] });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (template_id: string): Promise<{ message: string }> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to delete templates');
      }

      const response = await fetch(`${API_URL}/templates/${template_id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'marketplace-templates'] });
      queryClient.invalidateQueries({ queryKey: ['secure-mcp', 'my-templates'] });
    },
  });
}

export function useKortixTeamTemplates() {
  return useQuery({
    queryKey: ['secure-mcp', 'kortix-templates-all'],
    queryFn: async (): Promise<MarketplaceTemplatesResponse> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to view Kortix templates');
      }

      const response = await fetch(`${API_URL}/templates/kortix-all`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }
      
      return response.json();
    },
  });
}

export function useInstallTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: InstallTemplateRequest): Promise<InstallationResponse> => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('You must be logged in to install templates');
      }
      const response = await fetch(`${API_URL}/templates/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        const isAgentLimitError = (response.status === 402) && (
          errorData.error_code === 'AGENT_LIMIT_EXCEEDED' || 
          errorData.detail?.error_code === 'AGENT_LIMIT_EXCEEDED'
        );
        
        if (isAgentLimitError) {
          const { AgentCountLimitError } = await import('@/lib/api');
          const errorDetail = errorData.detail || errorData;
          throw new AgentCountLimitError(response.status, errorDetail);
        }
        
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['marketplace-templates'] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });
} 