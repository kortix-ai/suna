/**
 * Trigger API Hooks
 * 
 * React Query hooks for trigger CRUD operations
 * Following patterns from useApiQueries.ts
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '@/contexts/AuthContext';
import type {
  TriggerConfiguration,
  TriggerProvider,
  TriggerWithAgent,
  TriggerCreateRequest,
  TriggerUpdateRequest,
  TriggerResponse,
  ProviderResponse,
} from '@/api/types';

const API_BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8000';

// ===== QUERY FUNCTIONS =====

const fetchAllTriggers = async (token: string): Promise<TriggerWithAgent[]> => {
  const response = await fetch(`${API_BASE_URL}/triggers/all`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch triggers: ${response.statusText}`);
  }

  return response.json();
};

const fetchAgentTriggers = async (agentId: string, token: string): Promise<TriggerConfiguration[]> => {
  const response = await fetch(`${API_BASE_URL}/triggers/agents/${agentId}/triggers`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agent triggers: ${response.statusText}`);
  }

  return response.json();
};

const fetchTriggerProviders = async (token: string): Promise<TriggerProvider[]> => {
  const response = await fetch(`${API_BASE_URL}/triggers/providers`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch trigger providers: ${response.statusText}`);
  }

  return response.json();
};

const fetchTrigger = async (triggerId: string, token: string): Promise<TriggerResponse> => {
  const response = await fetch(`${API_BASE_URL}/triggers/${triggerId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch trigger: ${response.statusText}`);
  }

  return response.json();
};

// ===== MUTATION FUNCTIONS =====

const createTrigger = async ({
  agentId,
  data,
  token,
}: {
  agentId: string;
  data: TriggerCreateRequest;
  token: string;
}): Promise<TriggerResponse> => {
  const response = await fetch(`${API_BASE_URL}/triggers/agents/${agentId}/triggers`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to create trigger: ${response.statusText}`);
  }

  return response.json();
};

const updateTrigger = async ({
  triggerId,
  data,
  token,
}: {
  triggerId: string;
  data: TriggerUpdateRequest;
  token: string;
}): Promise<TriggerResponse> => {
  const response = await fetch(`${API_BASE_URL}/triggers/${triggerId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to update trigger: ${response.statusText}`);
  }

  return response.json();
};

const deleteTrigger = async ({
  triggerId,
  agentId,
  token,
}: {
  triggerId: string;
  agentId: string;
  token: string;
}): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/triggers/${triggerId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to delete trigger: ${response.statusText}`);
  }
};

const toggleTrigger = async ({
  triggerId,
  isActive,
  token,
}: {
  triggerId: string;
  isActive: boolean;
  token: string;
}): Promise<TriggerResponse> => {
  return updateTrigger({
    triggerId,
    data: { is_active: isActive },
    token,
  });
};

// ===== REACT QUERY HOOKS =====

export const useAllTriggers = () => {
  const { session } = useAuthContext();

  return useQuery({
    queryKey: ['triggers', 'all'],
    queryFn: () => fetchAllTriggers(session?.access_token || ''),
    enabled: !!session?.access_token,
    staleTime: 30 * 1000, // 30 seconds
    refetchOnWindowFocus: false,
  });
};

export const useAgentTriggers = (agentId: string) => {
  const { session } = useAuthContext();

  return useQuery({
    queryKey: ['triggers', 'agent', agentId],
    queryFn: () => fetchAgentTriggers(agentId, session?.access_token || ''),
    enabled: !!session?.access_token && !!agentId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
};

export const useTriggerProviders = () => {
  const { session } = useAuthContext();

  return useQuery({
    queryKey: ['triggers', 'providers'],
    queryFn: () => fetchTriggerProviders(session?.access_token || ''),
    enabled: !!session?.access_token,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
};

export const useTrigger = (triggerId: string) => {
  const { session } = useAuthContext();

  return useQuery({
    queryKey: ['triggers', triggerId],
    queryFn: () => fetchTrigger(triggerId, session?.access_token || ''),
    enabled: !!session?.access_token && !!triggerId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
};

export const useCreateTrigger = () => {
  const { session } = useAuthContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ agentId, data }: { agentId: string; data: TriggerCreateRequest }) =>
      createTrigger({ agentId, data, token: session?.access_token || '' }),
    onSuccess: (data, variables) => {
      // Invalidate and refetch triggers
      queryClient.invalidateQueries({ queryKey: ['triggers', 'all'] });
      queryClient.invalidateQueries({ queryKey: ['triggers', 'agent', variables.agentId] });
      
      // Add the new trigger to the cache
      queryClient.setQueryData(['triggers', data.trigger_id], data);
    },
  });
};

export const useUpdateTrigger = () => {
  const { session } = useAuthContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ triggerId, data }: { triggerId: string; data: TriggerUpdateRequest }) =>
      updateTrigger({ triggerId, data, token: session?.access_token || '' }),
    onSuccess: (data) => {
      // Update the specific trigger in cache
      queryClient.setQueryData(['triggers', data.trigger_id], data);
      
      // Invalidate lists to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['triggers', 'all'] });
      queryClient.invalidateQueries({ queryKey: ['triggers', 'agent', data.agent_id] });
    },
  });
};

export const useDeleteTrigger = () => {
  const { session } = useAuthContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ triggerId, agentId }: { triggerId: string; agentId: string }) =>
      deleteTrigger({ triggerId, agentId, token: session?.access_token || '' }),
    onSuccess: (_, variables) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: ['triggers', variables.triggerId] });
      
      // Invalidate lists
      queryClient.invalidateQueries({ queryKey: ['triggers', 'all'] });
      queryClient.invalidateQueries({ queryKey: ['triggers', 'agent', variables.agentId] });
    },
  });
};

export const useToggleTrigger = () => {
  const { session } = useAuthContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ triggerId, isActive }: { triggerId: string; isActive: boolean }) =>
      toggleTrigger({ triggerId, isActive, token: session?.access_token || '' }),
    onSuccess: (data) => {
      // Update the specific trigger in cache
      queryClient.setQueryData(['triggers', data.trigger_id], data);
      
      // Invalidate lists to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['triggers', 'all'] });
      queryClient.invalidateQueries({ queryKey: ['triggers', 'agent', data.agent_id] });
    },
  });
};
