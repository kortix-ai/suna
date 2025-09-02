import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TriggerConfiguration } from '@/components/agents/triggers/types';
import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

const fetchAgentTriggers = async (agentId: string): Promise<TriggerConfiguration[]> => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        throw new Error('You must be logged in to create a trigger');
    }
    const response = await fetch(`${API_URL}/triggers/agents/${agentId}/triggers`, {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch agent triggers');
  }
  return response.json();
};

const createTrigger = async (data: {
  agentId: string;
  provider_id: string;
  name: string;
  description?: string;
  config: Record<string, any>;
}): Promise<TriggerConfiguration> => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        throw new Error('You must be logged in to create a trigger');
    }
    const response = await fetch(`${API_URL}/triggers/agents/${data.agentId}/triggers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    body: JSON.stringify({
      provider_id: data.provider_id,
      name: data.name,
      description: data.description,
      config: data.config,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to create trigger');
  }
  
  return response.json();
};

const updateTrigger = async (data: {
  triggerId: string;
  name?: string;
  description?: string;
  config?: Record<string, any>;
  is_active?: boolean;
}): Promise<TriggerConfiguration> => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        throw new Error('You must be logged in to create a trigger');
    }
    const response = await fetch(`${API_URL}/triggers/${data.triggerId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    body: JSON.stringify({
      name: data.name,
      description: data.description,
      config: data.config,
      is_active: data.is_active,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to update trigger');
  }
  
  return response.json();
};

const deleteTrigger = async (data: { triggerId: string; agentId: string }): Promise<void> => {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('You must be logged in to create a trigger');
  }
  const response = await fetch(`${API_URL}/triggers/${data.triggerId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to delete trigger');
  }
};

export const useAgentTriggers = (agentId: string) => {
  return useQuery({
    queryKey: ['agent-triggers', agentId],
    queryFn: () => fetchAgentTriggers(agentId),
    enabled: !!agentId,
    staleTime: 2 * 60 * 1000,
  });
};

export const useCreateTrigger = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: createTrigger,
    onSuccess: (newTrigger) => {
      queryClient.invalidateQueries({ queryKey: ['agent-upcoming-runs', newTrigger.agent_id] });
      queryClient.invalidateQueries({ queryKey: ['all-triggers'] });
      queryClient.setQueryData(
        ['agent-triggers', newTrigger.agent_id],
        (old: TriggerConfiguration[] | undefined) => {
          return old ? [...old, newTrigger] : [newTrigger];
        }
      );
    },
  });
};

export const useUpdateTrigger = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: updateTrigger,
    onSuccess: (updatedTrigger) => {
      queryClient.invalidateQueries({ queryKey: ['agent-upcoming-runs', updatedTrigger.agent_id] });
      queryClient.invalidateQueries({ queryKey: ['all-triggers'] });
      queryClient.setQueryData(
        ['agent-triggers', updatedTrigger.agent_id],
        (old: TriggerConfiguration[] | undefined) => {
          if (!old) return [updatedTrigger];
          return old.map(trigger => 
            trigger.trigger_id === updatedTrigger.trigger_id ? updatedTrigger : trigger
          );
        }
      );
    },
  });
};

export const useDeleteTrigger = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: deleteTrigger,
    onSuccess: (_, { triggerId, agentId }) => {
      queryClient.invalidateQueries({ queryKey: ['agent-upcoming-runs', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agent-triggers'] });
      queryClient.invalidateQueries({ queryKey: ['all-triggers'] });
    },
  });
};

export const useToggleTrigger = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: { triggerId: string; isActive: boolean }) => {
      return updateTrigger({
        triggerId: data.triggerId,
        is_active: data.isActive,
      });
    },
    onSuccess: (updatedTrigger) => {
      queryClient.invalidateQueries({ queryKey: ['agent-upcoming-runs', updatedTrigger.agent_id] });
      queryClient.invalidateQueries({ queryKey: ['all-triggers'] });
      queryClient.setQueryData(
        ['agent-triggers', updatedTrigger.agent_id],
        (old: TriggerConfiguration[] | undefined) => {
          if (!old) return [updatedTrigger];
          return old.map(trigger => 
            trigger.trigger_id === updatedTrigger.trigger_id ? updatedTrigger : trigger
          );
        }
      );
    },
  });
}; 