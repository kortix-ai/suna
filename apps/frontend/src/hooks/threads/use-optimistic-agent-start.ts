'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';

import { optimisticAgentStart } from '@/lib/api/agents';
import { 
  BillingError, 
  AgentRunLimitError, 
  ProjectLimitError, 
  ThreadLimitError 
} from '@/lib/api/errors';
import { useOptimisticFilesStore } from '@/stores/optimistic-files-store';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { normalizeFilenameToNFC } from '@agentpress/shared';
import { 
  getStreamPreconnectService, 
  storePreconnectInfo 
} from '@/lib/streaming/stream-preconnect';

export interface OptimisticAgentStartOptions {
  message: string;
  fileIds?: string[];
  modelName?: string;
  agentId?: string;
  /** Mode starter to pass as query param (e.g., 'presentation') */
  modeStarter?: string;
  /** Mode for backend context (slides, sheets, docs, canvas, video, research) */
  mode?: string;
}

export interface OptimisticAgentStartResult {
  threadId: string;
  projectId: string;
  success: boolean;
}

export interface AgentLimitInfo {
  runningCount: number;
  runningThreadIds: string[];
}

export interface UseOptimisticAgentStartReturn {
  startAgent: (options: OptimisticAgentStartOptions) => Promise<OptimisticAgentStartResult | null>;
  isStarting: boolean;
  agentLimitData: AgentLimitInfo | null;
  showAgentLimitBanner: boolean;
  setShowAgentLimitBanner: (show: boolean) => void;
  clearAgentLimitData: () => void;
}

/**
 * Hook for handling optimistic agent start with navigation.
 * 
 * This centralizes the logic for:
 * - Generating thread/project IDs
 * - Storing optimistic data in sessionStorage
 * - Navigating to the new thread page
 * - Calling the backend API
 * - Handling errors uniformly (billing, limits, etc.)
 * 
 * @param redirectOnError - Path to redirect to on error (e.g., '/dashboard' or '/')
 */
export function useOptimisticAgentStart(
  redirectOnError: string = '/dashboard'
): UseOptimisticAgentStartReturn {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tBilling = useTranslations('billing');
  
  const [isStarting, setIsStarting] = useState(false);
  const [agentLimitData, setAgentLimitData] = useState<AgentLimitInfo | null>(null);
  const [showAgentLimitBanner, setShowAgentLimitBanner] = useState(false);
  
  const addOptimisticFiles = useOptimisticFilesStore((state) => state.addFiles);
  const pricingModalStore = usePricingModalStore();

  const clearAgentLimitData = useCallback(() => {
    setAgentLimitData(null);
    setShowAgentLimitBanner(false);
  }, []);

  const handleBillingError = useCallback((error: BillingError) => {
    const errorMessage = error.detail?.message?.toLowerCase() || error.message?.toLowerCase() || '';
    const originalMessage = error.detail?.message || error.message || '';
    const isCreditsExhausted = 
      errorMessage.includes('credit') ||
      errorMessage.includes('balance') ||
      errorMessage.includes('insufficient') ||
      errorMessage.includes('out of credits') ||
      errorMessage.includes('no credits');
    
    const balanceMatch = originalMessage.match(/balance is (-?\d+)\s*credits/i);
    const balance = balanceMatch ? balanceMatch[1] : null;
    
    const alertTitle = isCreditsExhausted 
      ? 'You ran out of credits'
      : 'Pick the plan that works for you';
    
    const alertSubtitle = balance 
      ? `Your current balance is ${balance} credits. Upgrade your plan to continue.`
      : isCreditsExhausted 
        ? 'Upgrade your plan to get more credits and continue using the AI assistant.'
        : undefined;
    
    router.replace(redirectOnError);
    pricingModalStore.openPricingModal({ 
      isAlert: true,
      alertTitle,
      alertSubtitle
    });
  }, [router, redirectOnError, pricingModalStore]);

  const handleAgentRunLimitError = useCallback((error: AgentRunLimitError) => {
    console.log('[OptimisticAgentStart] Caught AgentRunLimitError');
    const { running_thread_ids, running_count } = error.detail;
    setAgentLimitData({
      runningCount: running_count,
      runningThreadIds: running_thread_ids,
    });
    setShowAgentLimitBanner(true);
    router.replace(redirectOnError);
  }, [router, redirectOnError]);

  const handleProjectLimitError = useCallback((error: ProjectLimitError) => {
    router.replace(redirectOnError);
    pricingModalStore.openPricingModal({ 
      isAlert: true,
      alertTitle: `${tBilling('reachedLimit')} ${tBilling('projectLimit', { current: error.detail.current_count, limit: error.detail.limit })}` 
    });
  }, [router, redirectOnError, pricingModalStore, tBilling]);

  const handleThreadLimitError = useCallback((error: ThreadLimitError) => {
    router.replace(redirectOnError);
    pricingModalStore.openPricingModal({ 
      isAlert: true,
      alertTitle: `${tBilling('reachedLimit')} ${tBilling('threadLimit', { current: error.detail.current_count, limit: error.detail.limit })}` 
    });
  }, [router, redirectOnError, pricingModalStore, tBilling]);

  const startAgent = useCallback(async (
    options: OptimisticAgentStartOptions
  ): Promise<OptimisticAgentStartResult | null> => {
    const { message, fileIds = [], modelName, agentId, modeStarter, mode } = options;
    
    const trimmedMessage = message.trim();
    if (!trimmedMessage && fileIds.length === 0) {
      toast.error('Please enter a message or attach files');
      return null;
    }

    setIsStarting(true);

    const threadId = crypto.randomUUID();
    const projectId = crypto.randomUUID();

    try {
      sessionStorage.setItem('optimistic_prompt', message);
      sessionStorage.setItem('optimistic_thread', threadId);
      
      const pendingIntent = {
        threadId,
        projectId,
        prompt: message,
        fileIds: fileIds.length > 0 ? fileIds : undefined,
        modelName,
        agentId: agentId || undefined,
        mode,
        createdAt: Date.now(),
      };
      localStorage.setItem('pending_thread_intent', JSON.stringify(pendingIntent));

      if (process.env.NODE_ENV !== 'production') {
        console.log('[OptimisticAgentStart] Starting new thread:', {
          projectId,
          threadId,
          agent_id: agentId || undefined,
          model_name: modelName,
          promptLength: message.length,
          promptPreview: message.slice(0, 140),
          fileIds: fileIds.length,
        });
      }

      const queryParams = new URLSearchParams();
      queryParams.set('new', 'true');
      if (modeStarter) {
        queryParams.set('modeStarter', modeStarter);
      }
      router.push(`/projects/${projectId}/thread/${threadId}?${queryParams.toString()}`);

      optimisticAgentStart({
        thread_id: threadId,
        project_id: projectId,
        prompt: message,
        file_ids: fileIds.length > 0 ? fileIds : undefined,
        model_name: modelName,
        agent_id: agentId || undefined,
        mode: mode,
      }).then(async (response) => {
        console.log('[OptimisticAgentStart] API succeeded, response:', response);
        
        // Clear pending intent - thread was successfully created
        localStorage.removeItem('pending_thread_intent');
        
        // Store agent_run_id so thread page can use it immediately (no polling needed)
        if (response.agent_run_id) {
          // Pre-connect to stream immediately - this saves ~1-2s of connection overhead
          // The ThreadComponent will adopt this connection when it mounts
          try {
            const preconnectService = getStreamPreconnectService();
            const getAuthToken = async () => {
              const { createClient } = await import('@/lib/supabase/client');
              const supabase = createClient();
              const { data: { session } } = await supabase.auth.getSession();
              return session?.access_token || null;
            };
            
            storePreconnectInfo(response.agent_run_id, threadId);
            await preconnectService.preconnect(response.agent_run_id, threadId, getAuthToken);
            console.log('[OptimisticAgentStart] Stream pre-connected for', response.agent_run_id);
          } catch (preconnectError) {
            // Non-fatal - ThreadComponent will create its own connection
            console.warn('[OptimisticAgentStart] Stream pre-connect failed:', preconnectError);
          }

          // Set session storage AFTER preconnect is established to avoid race condition
          // where ThreadComponent tries to adopt before stream is ready
          sessionStorage.setItem('optimistic_agent_run_id', response.agent_run_id);
          sessionStorage.setItem('optimistic_agent_run_thread', threadId);
        }
        
        // Invalidate all relevant queries so the thread page picks up the new data
        queryClient.invalidateQueries({ queryKey: ['threads', 'list'] });
        queryClient.invalidateQueries({ queryKey: ['active-agent-runs'] });
        // Also invalidate the thread-specific queries
        queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
        queryClient.invalidateQueries({ queryKey: ['thread', threadId, 'agent-runs'] });
        queryClient.invalidateQueries({ queryKey: ['thread', threadId, 'messages'] });
        queryClient.invalidateQueries({ queryKey: ['project', projectId] });
        // Reset starting state
        setIsStarting(false);
      }).catch((error) => {
        console.error('[OptimisticAgentStart] Background agent start failed:', error);
        setIsStarting(false);
        
        // Clear pending intent on billing/limit errors (user action required)
        // Keep it for network errors so retry can happen
        const isBillingOrLimitError = 
          error instanceof BillingError || 
          error?.status === 402 ||
          error instanceof AgentRunLimitError ||
          error instanceof ProjectLimitError ||
          error instanceof ThreadLimitError ||
          error?.detail?.error_code === 'AGENT_RUN_LIMIT_EXCEEDED';
        
        if (isBillingOrLimitError) {
          localStorage.removeItem('pending_thread_intent');
        }
        
        if (error instanceof BillingError || error?.status === 402) {
          handleBillingError(error as BillingError);
          return;
        }
        
        if (error instanceof AgentRunLimitError) {
          handleAgentRunLimitError(error);
          return;
        }
        
        // Check for error code in case instanceof check fails
        if (error?.detail?.error_code === 'AGENT_RUN_LIMIT_EXCEEDED' || 
            error?.code === 'AGENT_RUN_LIMIT_EXCEEDED' ||
            (error?.status === 402 && error?.detail?.running_count !== undefined)) {
          const running_thread_ids = error.detail?.running_thread_ids || [];
          const running_count = error.detail?.running_count || 0;
          setAgentLimitData({
            runningCount: running_count,
            runningThreadIds: running_thread_ids,
          });
          setShowAgentLimitBanner(true);
          router.replace(redirectOnError);
          return;
        }
        
        if (error instanceof ProjectLimitError) {
          handleProjectLimitError(error);
          return;
        }
        
        if (error instanceof ThreadLimitError) {
          handleThreadLimitError(error);
          return;
        }
        
        toast.error('Failed to start conversation');
      });

      return { threadId, projectId, success: true };
    } catch (error: any) {
      console.error('[OptimisticAgentStart] Error during start:', error);
      
      // Clean up sessionStorage on error
      sessionStorage.removeItem('optimistic_prompt');
      sessionStorage.removeItem('optimistic_thread');
      sessionStorage.removeItem('optimistic_files');
      sessionStorage.removeItem('optimistic_file_previews');
      
      if (error instanceof BillingError) {
        handleBillingError(error);
      } else if (error instanceof AgentRunLimitError) {
        handleAgentRunLimitError(error);
      } else if (error instanceof ProjectLimitError) {
        handleProjectLimitError(error);
      } else if (error instanceof ThreadLimitError) {
        handleThreadLimitError(error);
      } else {
        toast.error(error.message || 'Failed to create Worker. Please try again.');
      }
      
      setIsStarting(false);
      return null;
    }
  }, [
    router,
    queryClient,
    redirectOnError,
    handleBillingError,
    handleAgentRunLimitError,
    handleProjectLimitError,
    handleThreadLimitError,
  ]);

  return {
    startAgent,
    isStarting,
    agentLimitData,
    showAgentLimitBanner,
    setShowAgentLimitBanner,
    clearAgentLimitData,
  };
}

