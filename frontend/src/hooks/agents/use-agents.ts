import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { agentKeys } from './keys';
import { Agent, AgentUpdateRequest, AgentsParams, createAgent, deleteAgent, getAgent, getAgents, getThreadAgent, updateAgent, ThreadAgentResponse } from './utils';
import { useRef, useCallback, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { AgentCountLimitError, CustomWorkerLimitError } from '@/lib/api/errors';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useTranslations } from 'next-intl';

// Default params for agent queries - standardize to avoid duplicate fetches
const DEFAULT_AGENT_PARAMS: AgentsParams = {
  limit: 50, // Standardized to 50 to match thread queries and avoid duplicate fetches
  sort_by: 'name',
  sort_order: 'asc',
};

/**
 * Smart hook that uses React Query cache efficiently.
 * - Normalizes empty params to use default params (to consolidate queries)
 * - Uses placeholderData from cached queries to avoid unnecessary refetches
 * - Shares cache between similar queries
 */
export const useAgents = (
  params: AgentsParams = {},
  customOptions?: Omit<
    UseQueryOptions<Awaited<ReturnType<typeof getAgents>>, Error, Awaited<ReturnType<typeof getAgents>>, ReturnType<typeof agentKeys.list>>,
    'queryKey' | 'queryFn' | 'placeholderData'
  >,
) => {
  const queryClient = useQueryClient();
  
  // Normalize params: always include defaults unless explicitly overridden
  // This ensures all queries use consistent parameters and share cache
  const normalizedParams = useMemo(() => {
    // Start with defaults
    const normalized: AgentsParams = {
      limit: DEFAULT_AGENT_PARAMS.limit,
      sort_by: DEFAULT_AGENT_PARAMS.sort_by,
      sort_order: DEFAULT_AGENT_PARAMS.sort_order,
    };
    
    // Override with provided params
    if (params.limit !== undefined) normalized.limit = params.limit;
    if (params.sort_by !== undefined) normalized.sort_by = params.sort_by;
    if (params.sort_order !== undefined) normalized.sort_order = params.sort_order;
    
    // Only include page if it's explicitly set AND > 1 (page 1 is default)
    if (params.page !== undefined && params.page > 1) {
      normalized.page = params.page;
    }
    
    // Include search/filter params if provided
    if (params.search) normalized.search = params.search;
    if (params.has_default !== undefined) normalized.has_default = params.has_default;
    if (params.has_mcp_tools !== undefined) normalized.has_mcp_tools = params.has_mcp_tools;
    if (params.has_agentpress_tools !== undefined) normalized.has_agentpress_tools = params.has_agentpress_tools;
    if (params.tools) normalized.tools = params.tools;
    if (params.content_type !== undefined) normalized.content_type = params.content_type;
    
    return normalized;
  }, [params]);
  
  // Get placeholder data from any existing agent list query in cache
  // This allows us to reuse cached data from other queries with different params
  const placeholderData = useMemo(() => {
    // Check if we already have data for this exact query
    const exactMatch = queryClient.getQueryData<Awaited<ReturnType<typeof getAgents>>>(
      agentKeys.list(normalizedParams)
    );
    if (exactMatch) return exactMatch;
    
    // Try to find any cached agent list query
    const allAgentQueries = queryClient.getQueriesData<Awaited<ReturnType<typeof getAgents>>>({ 
      queryKey: agentKeys.lists() 
    });
    
    // Find the most complete cached query (prefer ones with more agents)
    let bestMatch: Awaited<ReturnType<typeof getAgents>> | undefined;
    let maxAgents = 0;
    
    for (const [_, data] of allAgentQueries) {
      if (data?.agents && data.agents.length > maxAgents) {
        maxAgents = data.agents.length;
        bestMatch = data;
      }
    }
    
    // If we have cached data and the params don't include search/filters,
    // we can use the cached data as placeholder to show data immediately
    const hasSearchOrFilters = normalizedParams.search || 
                               normalizedParams.has_default !== undefined || 
                               normalizedParams.has_mcp_tools !== undefined || 
                               normalizedParams.has_agentpress_tools !== undefined ||
                               normalizedParams.tools || 
                               normalizedParams.content_type;
    
    // Only use placeholder if we don't have search/filters that would change results
    // and if we're not requesting a specific page (since pagination changes results)
    const isPaginated = normalizedParams.page !== undefined && normalizedParams.page > 1;
    
    if (bestMatch && !hasSearchOrFilters && !isPaginated) {
      return bestMatch;
    }
    
    return undefined;
  }, [queryClient, normalizedParams]);
  
  return useQuery({
    queryKey: agentKeys.list(normalizedParams),
    queryFn: () => getAgents(normalizedParams),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    enabled: true, // Default to enabled, can be overridden
    placeholderData, // Use cached data from other queries as placeholder
    ...customOptions,
  });
};

export const useAgent = (agentId: string, options?) => {
  return useQuery<Agent>({
    queryKey: agentKeys.detail(agentId),
    queryFn: () => getAgent(agentId),
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    ...options,
  });
};

export const useCreateAgent = () => {
  const queryClient = useQueryClient();
  
  return useMutation<Agent, Error, AgentUpdateRequest>({
    mutationFn: createAgent,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      queryClient.setQueryData(agentKeys.detail(data.agent_id), data);
      toast.success('Worker created successfully');
    },
    onError: async (error) => {
      const { AgentCountLimitError } = await import('@/lib/api/errors');
      if (error instanceof AgentCountLimitError) {
        return;
      }
      console.error('Error creating agent:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create agent');
    },
  });
};

export const useCreateNewAgent = () => {
  const router = useRouter();
  const createAgentMutation = useCreateAgent();
  const pricingModalStore = usePricingModalStore();
  const tBilling = useTranslations('billing');

  return useMutation({
    mutationFn: async (_: void) => {
      const defaultAgentData = {
        name: 'New Worker',
        description: 'A newly created worker, open for configuration',
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
    onError: (error) => {
      if (error instanceof AgentCountLimitError || error instanceof CustomWorkerLimitError) {
        pricingModalStore.openPricingModal({ 
          isAlert: true,
          alertTitle: `${tBilling('reachedLimit')} ${tBilling('workerLimit', { current: error.detail.current_count, limit: error.detail.limit })}` 
        });
      }
    },
  });
};

export const useUpdateAgent = () => {
  const queryClient = useQueryClient();
  
  return useMutation<Agent, Error, { agentId: string } & AgentUpdateRequest>({
    mutationFn: ({ agentId, ...data }: { agentId: string } & AgentUpdateRequest) => 
      updateAgent(agentId, data),
    onSuccess: (data, variables) => {
      // Update the cache optimistically
      queryClient.setQueryData(agentKeys.detail(variables.agentId), data);
      // Invalidate to ensure all dependent queries are refreshed
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(variables.agentId) });
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
};

export const useDeleteAgent = () => {
  const queryClient = useQueryClient();
  
  return useMutation<void, Error, string, { previousAgents: Array<[any, any]> }>({
    mutationFn: deleteAgent,
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
  });
};

interface DeleteMultipleAgentsVariables {
  agentIds: string[];
  onProgress?: (completed: number, total: number) => void;
}

export const useDeleteMultipleAgents = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ agentIds, onProgress }: DeleteMultipleAgentsVariables) => {
      let completedCount = 0;
      const results = await Promise.all(
        agentIds.map(async (agentId) => {
          try {
            await deleteAgent(agentId);
            completedCount++;
            onProgress?.(completedCount, agentIds.length);
            return { success: true, agentId };
          } catch (error) {
            return { success: false, agentId, error };
          }
        })
      );
      
      return {
        successful: results.filter(r => r.success).map(r => r.agentId),
        failed: results.filter(r => !r.success).map(r => r.agentId),
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
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

export const useThreadAgent = (threadId: string, options?) => {
  return useQuery<ThreadAgentResponse>({
    queryKey: agentKeys.threadAgent(threadId),
    queryFn: () => getThreadAgent(threadId),
    enabled: !!threadId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    ...options,
  });
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
