import { useQuery, useMutation } from "@tanstack/react-query";
import { threadKeys } from "./keys";
import { getAgentRuns, unifiedAgentStart, stopAgent, type AgentRun } from "@/lib/api/agents";
import { AgentRunLimitError, BillingError } from "@/lib/api/errors";
import { useQueryClient } from "@tanstack/react-query";

export const useAgentRunsQuery = (threadId: string, options?) => {
  return useQuery<AgentRun[]>({
    queryKey: threadKeys.agentRuns(threadId),
    queryFn: () => getAgentRuns(threadId),
    enabled: !!threadId,
    retry: 1,
    ...options,
  });
};

export const useStartAgentMutation = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({
      threadId,
      options,
    }: {
      threadId: string;
      options?: {
        model_name?: string;
        agent_id?: string;
      };
    }) => unifiedAgentStart({
      threadId,
      model_name: options?.model_name && options.model_name.trim() ? options.model_name.trim() : undefined,
      agent_id: options?.agent_id,
    }),
    onSuccess: () => {
      // Invalidate active agent runs to update the sidebar status indicators
      queryClient.invalidateQueries({ queryKey: ['active-agent-runs'] });
    },
    onError: (error) => {
      // Only silently handle BillingError - let AgentRunLimitError bubble up to be handled by the page component
      if (!(error instanceof BillingError)) {
        throw error;
      }
    },
  });
};

export const useStopAgentMutation = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (agentRunId: string) => stopAgent(agentRunId),
    onSuccess: () => {
      // Invalidate active agent runs to update the sidebar status indicators
      queryClient.invalidateQueries({ queryKey: ['active-agent-runs'] });
    },
  });
};
