import { createMutationHook, createQueryHook } from '@/hooks/use-query';
import { useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { agentKeys } from './keys';
import { Agent, AgentUpdateRequest, AgentsParams, createAgent, deleteAgent, getAgent, getAgents, getThreadAgent, updateAgent } from './utils';
import { useRef, useCallback, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';

export const useAgents = (
  params: AgentsParams = {},
  customOptions?: Omit<
    UseQueryOptions<Awaited<ReturnType<typeof getAgents>>, Error, Awaited<ReturnType<typeof getAgents>>, ReturnType<typeof agentKeys.list>>,
    'queryKey' | 'queryFn'
  >,
) => {
  return createQueryHook(
    agentKeys.list(params),
    () => getAgents(params),
    {
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
    }
  )(customOptions);
};

export const useAgent = (agentId: string) => {
  return createQueryHook(
    agentKeys.detail(agentId),
    () => getAgent(agentId),
    {
      enabled: !!agentId,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
    }
  )();
};

export const useCreateAgent = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    createAgent,
    {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
        queryClient.setQueryData(agentKeys.detail(data.agent_id), data);
        toast.success('Agent created successfully');
      },
      onError: async (error) => {
        const { AgentCountLimitError } = await import('@/lib/api');
        if (error instanceof AgentCountLimitError) {
          return;
        }
        console.error('Error creating agent:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to create agent');
      },
    }
  )();
};

export const useCreateNewAgent = () => {
  const router = useRouter();
  const createAgentMutation = useCreateAgent();
  
  return createMutationHook(
    async (_: void) => {
      const defaultAgentData = {
        name: 'New Agent',
        description: 'A newly created agent, open for configuration',
        configured_mcps: [],
        agentpress_tools: {},
        is_default: false,
        icon_name: 'brain',
        icon_color: '#000000',
        icon_background: '#F3F4F6',
      };

      const newAgent = await createAgentMutation.mutateAsync(defaultAgentData);
      return newAgent;
    },
    {
      onSuccess: (newAgent) => {
      },
      onError: (error) => {
        console.error('Error creating agent:', error);
        toast.error('Failed to create agent. Please try again.');
      },
    }
  )();
};

export const useUpdateAgent = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    ({ agentId, ...data }: { agentId: string } & AgentUpdateRequest) => 
      updateAgent(agentId, data),
    {
      onSuccess: (data, variables) => {
        queryClient.setQueryData(agentKeys.detail(variables.agentId), data);
        queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      },
    }
  )();
};

export const useDeleteAgent = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    deleteAgent,
    {
      onMutate: async (agentId) => {
        // Cancel any outgoing refetches
        await queryClient.cancelQueries({ queryKey: agentKeys.lists() });
        
        // Snapshot the previous value
        const previousAgents = queryClient.getQueriesData({ queryKey: agentKeys.lists() });
        
        // Optimistically update to remove the agent
        queryClient.setQueriesData({ queryKey: agentKeys.lists() }, (old: any) => {
          if (!old || !old.agents) return old;
          
          return {
            ...old,
            agents: old.agents.filter((agent: any) => agent.agent_id !== agentId),
            pagination: old.pagination ? {
              ...old.pagination,
              total: Math.max(0, old.pagination.total - 1)
            } : undefined
          };
        });
        
        return { previousAgents };
      },
      onError: (err, agentId, context) => {
        // Revert the optimistic update on error
        if (context?.previousAgents) {
          context.previousAgents.forEach(([queryKey, data]) => {
            queryClient.setQueryData(queryKey, data);
          });
        }
        toast.error('Failed to delete agent. Please try again.');
      },
      onSuccess: (_, agentId) => {
        // Remove the individual agent query
        queryClient.removeQueries({ queryKey: agentKeys.detail(agentId) });
        toast.success('Agent deleted successfully');
      },
      onSettled: () => {
        // Always invalidate to ensure consistency
        queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      },
    }
  )();
};

export const useOptimisticAgentUpdate = () => {
  const queryClient = useQueryClient();
  
  return {
    optimisticallyUpdateAgent: (agentId: string, updates: Partial<Agent>) => {
      queryClient.setQueryData(
        agentKeys.detail(agentId),
        (oldData: Agent | undefined) => {
          if (!oldData) return oldData;
          return { ...oldData, ...updates };
        }
      );
    },
    
    revertOptimisticUpdate: (agentId: string) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    },
  };
};

export const useAgentDeletionState = () => {
  const [deletingAgents, setDeletingAgents] = useState<Set<string>>(new Set());
  const deleteAgentMutation = useDeleteAgent();

  const deleteAgent = useCallback(async (agentId: string) => {
    // Add to deleting set immediately for UI feedback
    setDeletingAgents(prev => new Set(prev).add(agentId));
    
    try {
      await deleteAgentMutation.mutateAsync(agentId);
    } finally {
      // Remove from deleting set regardless of success/failure
      setDeletingAgents(prev => {
        const newSet = new Set(prev);
        newSet.delete(agentId);
        return newSet;
      });
    }
  }, [deleteAgentMutation]);

  return {
    deleteAgent,
    isDeletingAgent: (agentId: string) => deletingAgents.has(agentId),
    isDeleting: deleteAgentMutation.isPending,
  };
};

export const useThreadAgent = (threadId: string) => {
  return createQueryHook(
    agentKeys.threadAgent(threadId),
    () => getThreadAgent(threadId),
    {
      enabled: !!threadId,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
    }
  )();
};

/**
 * Hook to get an agent from the cache without fetching.
 * This checks all cached agent list queries to find the agent.
 * Returns undefined if not found in cache.
 */
export const useAgentFromCache = (agentId: string | undefined): Agent | undefined => {
  const queryClient = useQueryClient();
  
  return useMemo(() => {
    if (!agentId) return undefined;

    // First check if we have it in the detail cache
    const cachedAgent = queryClient.getQueryData<Agent>(agentKeys.detail(agentId));
    if (cachedAgent) return cachedAgent;

    // Otherwise, search through all agent list caches
    const allAgentLists = queryClient.getQueriesData<{ agents: Agent[] }>({ 
      queryKey: agentKeys.lists() 
    });

    for (const [_, data] of allAgentLists) {
      if (data?.agents) {
        const found = data.agents.find(agent => agent.agent_id === agentId);
        if (found) return found;
      }
    }

    return undefined;
  }, [agentId, queryClient]);
};

/**
 * Hook to get multiple agents from cache by IDs.
 * Returns a map of agentId -> Agent for quick lookup.
 */
export const useAgentsFromCache = (agentIds: string[]): Map<string, Agent> => {
  const queryClient = useQueryClient();
  
  return useMemo(() => {
    const agentsMap = new Map<string, Agent>();
    
    if (!agentIds || agentIds.length === 0) return agentsMap;

    // Get all cached agent list queries
    const allAgentLists = queryClient.getQueriesData<{ agents: Agent[] }>({ 
      queryKey: agentKeys.lists() 
    });

    // Build a map of all cached agents
    const allCachedAgents = new Map<string, Agent>();
    for (const [_, data] of allAgentLists) {
      if (data?.agents) {
        data.agents.forEach(agent => {
          allCachedAgents.set(agent.agent_id, agent);
        });
      }
    }

    // Also check individual agent caches
    for (const agentId of agentIds) {
      const cachedAgent = queryClient.getQueryData<Agent>(agentKeys.detail(agentId));
      if (cachedAgent) {
        allCachedAgents.set(agentId, cachedAgent);
      }
    }

    // Return only the requested agents
    for (const agentId of agentIds) {
      const agent = allCachedAgents.get(agentId);
      if (agent) {
        agentsMap.set(agentId, agent);
      }
    }

    return agentsMap;
  }, [agentIds, queryClient]);
};