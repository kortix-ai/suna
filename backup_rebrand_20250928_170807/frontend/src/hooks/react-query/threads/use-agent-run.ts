import { createMutationHook, createQueryHook } from "@/hooks/use-query";
import { threadKeys } from "./keys";
import { BillingError, AgentRunLimitError, getAgentRuns, startAgent, stopAgent } from "@/lib/api";

export const useAgentRunsQuery = (threadId: string) =>
  createQueryHook(
    threadKeys.agentRuns(threadId),
    () => getAgentRuns(threadId),
    {
      enabled: !!threadId,
      retry: 1,
    }
  )();

export const useStartAgentMutation = () =>
  createMutationHook(
    ({
      threadId,
      options,
    }: {
      threadId: string;
      options?: {
        model_name?: string;
        enable_thinking?: boolean;
        reasoning_effort?: string;
        stream?: boolean;
        agent_id?: string;
      };
    }) => startAgent(threadId, options),
    {
      onError: (error) => {
        // Only silently handle BillingError - let AgentRunLimitError bubble up to be handled by the page component
        if (!(error instanceof BillingError)) {
          throw error;
        }
      },
    }
  )();

export const useStopAgentMutation = () =>
  createMutationHook((agentRunId: string) => stopAgent(agentRunId))();
