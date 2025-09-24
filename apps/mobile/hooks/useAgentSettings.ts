import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AvailableModelsResponse,
  fetchAgentDetails,
  fetchAgentKnowledgeBase,
  fetchAgentTriggers,
  fetchAgents,
  fetchAvailableModels,
  KnowledgeBaseEntry,
  KnowledgeBaseListResponse,
  updateKnowledgeBaseEntry,
  updateTriggerState,
  TriggerConfiguration,
  Agent,
  AgentsResponse,
} from '@/api/agent-settings';

const QUERY_KEYS = {
  models: ['agent-settings', 'models'] as const,
  agents: ['agent-settings', 'agents'] as const,
  agent: (agentId: string) => ['agent-settings', 'agent', agentId] as const,
  knowledgeBase: (agentId: string) => ['agent-settings', 'knowledge-base', agentId] as const,
  triggers: (agentId: string) => ['agent-settings', 'triggers', agentId] as const,
};

export const useAvailableModelsQuery = () =>
  useQuery<AvailableModelsResponse, Error>({
    queryKey: QUERY_KEYS.models,
    queryFn: fetchAvailableModels,
    staleTime: 10 * 60 * 1000,
  });

export const useAgentsQuery = (limit = 50) =>
  useQuery<AgentsResponse, Error>({
    queryKey: [...QUERY_KEYS.agents, limit],
    queryFn: () => fetchAgents(limit),
    staleTime: 5 * 60 * 1000,
  });

export const useAgentDetailsQuery = (agentId?: string | null) =>
  useQuery<Agent, Error>({
    queryKey: agentId ? QUERY_KEYS.agent(agentId) : QUERY_KEYS.agent('empty'),
    queryFn: () => fetchAgentDetails(agentId as string),
    enabled: !!agentId,
    staleTime: 60 * 1000,
  });

export const useKnowledgeBaseQuery = (agentId?: string | null) =>
  useQuery<{ entries: KnowledgeBaseEntry[]; total_count: number; total_tokens: number }, Error>({
    queryKey: agentId ? QUERY_KEYS.knowledgeBase(agentId) : QUERY_KEYS.knowledgeBase('empty'),
    queryFn: () => fetchAgentKnowledgeBase(agentId as string),
    enabled: !!agentId,
  });

export const useTriggersQuery = (agentId?: string | null) =>
  useQuery<TriggerConfiguration[], Error>({
    queryKey: agentId ? QUERY_KEYS.triggers(agentId) : QUERY_KEYS.triggers('empty'),
    queryFn: () => fetchAgentTriggers(agentId as string),
    enabled: !!agentId,
  });

export const useToggleKnowledgeEntryMutation = (agentId?: string | null) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ entryId, isActive }: { entryId: string; isActive: boolean }) =>
      updateKnowledgeBaseEntry(entryId, { is_active: isActive }),
    onSuccess: (_, variables) => {
      if (agentId) {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.knowledgeBase(agentId) });
      }
      // Optimistically update cache if present
      if (agentId) {
        queryClient.setQueryData<KnowledgeBaseListResponse | undefined>(
          QUERY_KEYS.knowledgeBase(agentId),
          (prev: KnowledgeBaseListResponse | undefined) => {
            if (!prev) return prev;
            return {
              ...prev,
              entries: prev.entries.map((entry) =>
                entry.entry_id === variables.entryId
                  ? { ...entry, is_active: variables.isActive }
                  : entry,
              ),
            };
          },
        );
      }
    },
  });
};

export const useToggleTriggerMutation = (agentId?: string | null) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ triggerId, isActive }: { triggerId: string; isActive: boolean }) =>
      updateTriggerState(triggerId, { is_active: isActive }),
    onSuccess: (data) => {
      if (agentId) {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.triggers(agentId) });
      }
      if (agentId) {
        queryClient.setQueryData<TriggerConfiguration[] | undefined>(
          QUERY_KEYS.triggers(agentId),
          (prev: TriggerConfiguration[] | undefined) => {
            if (!prev) return prev;
            return prev.map((trigger) =>
              trigger.trigger_id === data.trigger_id ? data : trigger,
            );
          },
        );
      }
    },
  });
};
