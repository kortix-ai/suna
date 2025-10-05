'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

interface ComposioAppsWithTriggersResponse {
  success: boolean;
  items: Array<{
    slug: string;
    name: string;
    logo?: string;
  }>;
  total: number;
}

export interface ComposioTriggerType {
  slug: string;
  name: string;
  description?: string;
  type: string;
  instructions?: string;
  config?: {
    title?: string;
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  payload?: Record<string, any>;
  toolkit: {
    slug: string;
    name: string;
    logo?: string;
  };
}

interface ComposioAppTriggersResponse {
  success: boolean;
  items: ComposioTriggerType[];
  toolkit: {
    slug: string;
    name: string;
    logo?: string;
  };
  total: number;
}

export const useComposioAppsWithTriggers = () => {
  return useQuery({
    queryKey: ['composio', 'apps-with-triggers'],
    queryFn: async (): Promise<ComposioAppsWithTriggersResponse> => {
      const res = await backendApi.get<ComposioAppsWithTriggersResponse>('/composio/triggers/apps');
      if (!res.success) throw new Error(res.error?.message || 'Failed to load apps');
      return res.data!;
    },
    staleTime: 5 * 60 * 1000,
  });
};

export const useComposioAppTriggers = (toolkitSlug?: string, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['composio', 'app-triggers', toolkitSlug],
    queryFn: async (): Promise<ComposioAppTriggersResponse> => {
      const res = await backendApi.get<ComposioAppTriggersResponse>(`/composio/triggers/apps/${toolkitSlug}`);
      if (!res.success) throw new Error(res.error?.message || 'Failed to load triggers');
      return res.data!;
    },
    enabled: enabled && !!toolkitSlug,
    staleTime: 5 * 60 * 1000,
  });
};

export interface CreateComposioEventTriggerRequest {
  agent_id: string;
  profile_id: string;
  slug: string;
  trigger_config: Record<string, any>;
  route: 'agent';
  name?: string;
  agent_prompt?: string;
  connected_account_id?: string;
  toolkit_slug?: string;
}

export const useCreateComposioEventTrigger = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateComposioEventTriggerRequest) => {
      const res = await backendApi.post('/composio/triggers/create', payload);
      if (!res.success) {
        throw res.error || new Error('Failed to create trigger');
      }
      return res.data as any;
    },
    onSuccess: (data) => {
      const agentId = (data?.agent_id as string) || undefined;
      if (agentId) {
        queryClient.invalidateQueries({ queryKey: ['agent-triggers', agentId] });
      }
      queryClient.invalidateQueries({ queryKey: ['all-triggers'] });
    }
  });
};


