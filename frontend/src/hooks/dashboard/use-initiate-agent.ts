'use client';

import { unifiedAgentStart, UnifiedAgentStartResponse } from "@/lib/api/agents";
import { AgentRunLimitError, BillingError } from "@/lib/api/errors";
import { useMutation } from "@tanstack/react-query";
import { handleApiSuccess, handleApiError } from "@/lib/error-handler";
import { dashboardKeys } from "./keys";
import { useQueryClient } from "@tanstack/react-query";

import { projectKeys, threadKeys } from "../threads/keys";

export const useInitiateAgentMutation = () => {
  return useMutation<
    UnifiedAgentStartResponse, 
    Error,
    FormData
  >({
    mutationFn: async (formData: FormData) => {
      // Extract FormData fields
      const prompt_raw = formData.get('prompt') as string | undefined | null;
      // For prompt, keep empty string (don't convert to undefined) so backend can validate
      // The backend requires prompt for new threads, so we need to send it even if empty
      const prompt = prompt_raw !== null && prompt_raw !== undefined ? prompt_raw.trim() : undefined;
      const model_name_raw = formData.get('model_name') as string | undefined | null;
      const model_name = model_name_raw && model_name_raw.trim() ? model_name_raw.trim() : undefined;
      const agent_id = formData.get('agent_id') as string | undefined;
      const files = formData.getAll('files') as File[];
      
      // Debug logging
      console.log('[useInitiateAgent] Extracted from FormData:', {
        prompt: prompt ? prompt.substring(0, 100) : prompt === '' ? '(empty string)' : undefined,
        promptLength: prompt?.length ?? (prompt === '' ? 0 : undefined),
        promptIsEmptyString: prompt === '',
        model_name,
        agent_id,
        filesCount: files.length,
      });
      
      return await unifiedAgentStart({
        prompt: prompt !== undefined ? prompt : undefined, // Send empty string if present, undefined if not in FormData
        model_name,
        agent_id,
        files: files.length > 0 ? files : undefined,
      });
    },
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
  });
};

export const useInitiateAgentWithInvalidation = () => {
  const queryClient = useQueryClient();
  const baseMutation = useInitiateAgentMutation();
  
  return useMutation({
    mutationFn: baseMutation.mutateAsync,
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
