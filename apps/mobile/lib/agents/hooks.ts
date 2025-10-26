/**
 * Agent API Hooks
 * 
 * React Query hooks for agent CRUD operations.
 * Following the same patterns as useApiQueries.ts
 */

import { useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseQueryOptions } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';
import type {
  Agent,
  AgentsResponse,
  AgentsParams,
  AgentCreateRequest,
  AgentUpdateRequest,
} from '@/api/types';

// ============================================================================
// Query Keys
// ============================================================================

export const agentKeys = {
  all: ['agents'] as const,
  lists: () => [...agentKeys.all, 'list'] as const,
  list: (params: AgentsParams) => [...agentKeys.lists(), params] as const,
  details: () => [...agentKeys.all, 'detail'] as const,
  detail: (id: string) => [...agentKeys.details(), id] as const,
};

// ============================================================================
// Agent List Hooks
// ============================================================================

export function useAgents(
  params: AgentsParams = {},
  options?: Omit<UseQueryOptions<AgentsResponse, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: agentKeys.list(params),
    queryFn: async () => {
      console.log('🔄 Fetching agents...');
      const headers = await getAuthHeaders();
      console.log('📋 Auth headers obtained:', headers);
      
      // Build query parameters
      const queryParams = new URLSearchParams();
      if (params.page) queryParams.append('page', params.page.toString());
      if (params.limit) queryParams.append('limit', params.limit.toString());
      if (params.search) queryParams.append('search', params.search);
      if (params.sort_by) queryParams.append('sort_by', params.sort_by);
      if (params.sort_order) queryParams.append('sort_order', params.sort_order);
      if (params.has_default !== undefined) queryParams.append('has_default', params.has_default.toString());
      if (params.has_mcp_tools !== undefined) queryParams.append('has_mcp_tools', params.has_mcp_tools.toString());
      if (params.has_agentpress_tools !== undefined) queryParams.append('has_agentpress_tools', params.has_agentpress_tools.toString());
      if (params.tools) queryParams.append('tools', params.tools);
      if (params.content_type) queryParams.append('content_type', params.content_type);

      const url = `${API_URL}/agents${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      console.log('🌐 API URL:', url);
      
      const res = await fetch(url, { headers });
      console.log('📡 Response status:', res.status);
      console.log('📡 Response headers:', Object.fromEntries(res.headers.entries()));
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error('❌ Failed to fetch agents:', res.status, errorText);
        throw new Error(`Failed to fetch agents: ${res.status} - ${errorText}`);
      }
      
      const data = await res.json();
      console.log('✅ Agents fetched successfully:', data);
      console.log('📊 Agents count:', data.agents?.length || 0);
      
      return data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: (failureCount, error) => {
      console.log(`🔄 Retry attempt ${failureCount} for agents fetch:`, error.message);
      return failureCount < 3;
    },
    ...options,
  });
}

// ============================================================================
// Single Agent Hooks
// ============================================================================

export function useAgent(
  agentId: string | undefined,
  options?: Omit<UseQueryOptions<Agent, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: agentKeys.detail(agentId || ''),
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_URL}/agents/${agentId}`, { headers });
      if (!res.ok) throw new Error(`Failed to fetch agent: ${res.status}`);
      return res.json();
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}

// ============================================================================
// Agent Mutation Hooks
// ============================================================================

export function useCreateAgent(
  options?: UseMutationOptions<Agent, Error, AgentCreateRequest>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (agentData: AgentCreateRequest) => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_URL}/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(agentData),
      });
      if (!res.ok) throw new Error(`Failed to create agent: ${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      queryClient.setQueryData(agentKeys.detail(data.agent_id), data);
    },
    ...options,
  });
}

export function useUpdateAgent(
  options?: UseMutationOptions<Agent, Error, { agentId: string; data: AgentUpdateRequest }>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, data }) => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_URL}/agents/${agentId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Failed to update agent: ${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      queryClient.setQueryData(agentKeys.detail(data.agent_id), data);
    },
    ...options,
  });
}

export function useDeleteAgent(
  options?: UseMutationOptions<void, Error, string>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (agentId: string) => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_URL}/agents/${agentId}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) throw new Error(`Failed to delete agent: ${res.status}`);
    },
    onSuccess: (_, agentId) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      queryClient.removeQueries({ queryKey: agentKeys.detail(agentId) });
    },
    ...options,
  });
}




