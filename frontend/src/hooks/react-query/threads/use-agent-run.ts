import { createMutationHook, createQueryHook } from "@/hooks/use-query";
import { threadKeys } from "./keys";
import { BillingError, AgentRunLimitError, getAgentRuns, startAgent, stopAgent } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

export const useAgentRunsQuery = (threadId: string) =>
  createQueryHook(
    threadKeys.agentRuns(threadId),
    () => getAgentRuns(threadId),
    {
      enabled: !!threadId,
      retry: 1,
    }
  )();

export const useStartAgentMutation = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    ({
      threadId,
      options,
    }: {
      threadId: string;
      options?: {
        model_name?: string;
        agent_id?: string;
      };
    }) => startAgent(threadId, options),
    {
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
    }
  )();
};

export const useStopAgentMutation = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    (agentRunId: string) => stopAgent(agentRunId),
    {
      onSuccess: () => {
        // Invalidate active agent runs to update the sidebar status indicators
        queryClient.invalidateQueries({ queryKey: ['active-agent-runs'] });
      },
    }
  )();
};
