'use client';

import { unifiedAgentStart, UnifiedAgentStartResponse, BillingError, AgentRunLimitError } from "@/lib/api";
import { createMutationHook } from "@/hooks/use-query";
import { handleApiSuccess, handleApiError } from "@/lib/error-handler";
import { dashboardKeys } from "./keys";
import { useQueryClient } from "@tanstack/react-query";

import { projectKeys, threadKeys } from "../sidebar/keys";

export const useInitiateAgentMutation = createMutationHook<
  UnifiedAgentStartResponse, 
  FormData
>(
  async (formData: FormData) => {
    // Extract FormData fields
    const prompt = formData.get('prompt') as string;
    const model_name = formData.get('model_name') as string | undefined;
    const agent_id = formData.get('agent_id') as string | undefined;
    const files = formData.getAll('files') as File[];
    
    return await unifiedAgentStart({
      prompt,
      model_name,
      agent_id,
      files: files.length > 0 ? files : undefined,
    });
  },
  {
    errorContext: { operation: 'initiate agent', resource: 'AI assistant' },
    onSuccess: (data) => {
      handleApiSuccess("Agent initiated successfully", "Your AI assistant is ready to help");
    },
    onError: (error) => {
      // Let BillingError and AgentRunLimitError bubble up to be handled by components
      if (error instanceof BillingError || error instanceof AgentRunLimitError) {
        throw error;
      }
      if (error instanceof Error && error.message.toLowerCase().includes("payment required")) {
        return;
      }
      handleApiError(error, { operation: 'initiate agent', resource: 'AI assistant' });
    }
  }
);

export const useInitiateAgentWithInvalidation = () => {
  const queryClient = useQueryClient();
  return useInitiateAgentMutation({
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: threadKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.agents });
    },
    onError: (error) => {
      if (error instanceof AgentRunLimitError || error instanceof BillingError) {
        throw error;
      }
      if (error instanceof Error) {
        const errorMessage = error.message;
        if (errorMessage.toLowerCase().includes("payment required")) {
          // Throw BillingError so components can handle it consistently
          throw new BillingError(402, { message: "Payment required to continue" });
        }
      }
    }
  });
};
