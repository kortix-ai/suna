'use client';

import { unifiedAgentStart, UnifiedAgentStartResponse } from "@/lib/api/agents";
import { 
  AgentRunLimitError, 
  BillingError, 
  ProjectLimitError, 
  ThreadLimitError,
  AgentCountLimitError,
  TriggerLimitError,
  CustomWorkerLimitError,
  ModelAccessDeniedError
} from "@/lib/api/errors";
import { useMutation, useQuery } from "@tanstack/react-query";
import { handleApiSuccess, handleApiError } from "@/lib/error-handler";
import { dashboardKeys } from "./keys";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from 'next-intl';

import { projectKeys, threadKeys } from "../threads/keys";
import { backendApi } from "@/lib/api-client";

export const useInitiateAgentMutation = () => {
  const t = useTranslations('dashboard');
  
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
      handleApiSuccess(t('agentInitiatedSuccessfully'), t('aiAssistantReady'));
    },
    onError: (error) => {
      // Let all limit/billing errors bubble up to be handled by components
      // This ensures a single source of truth for error handling
      if (error instanceof BillingError || 
          error instanceof AgentRunLimitError ||
          error instanceof ProjectLimitError ||
          error instanceof ThreadLimitError ||
          error instanceof AgentCountLimitError ||
          error instanceof TriggerLimitError ||
          error instanceof CustomWorkerLimitError ||
          error instanceof ModelAccessDeniedError) {
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
      if (error instanceof BillingError || 
          error instanceof AgentRunLimitError ||
          error instanceof ProjectLimitError ||
          error instanceof ThreadLimitError ||
          error instanceof AgentCountLimitError ||
          error instanceof TriggerLimitError ||
          error instanceof CustomWorkerLimitError ||
          error instanceof ModelAccessDeniedError) {
        throw error;
      }
      if (error instanceof Error) {
        const errorMessage = error.message;
        if (errorMessage.toLowerCase().includes("payment required")) {
          throw new BillingError(402, { message: "Payment required to continue" });
        }
      }
    }
  });
};
