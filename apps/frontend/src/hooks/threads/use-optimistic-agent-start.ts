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
  ThreadLimitError,
  formatTierErrorForUI
} from '@/lib/api/errors';
import { isTierRestrictionError } from '@agentpress/shared/errors';
import { useOptimisticFilesStore } from '@/stores/optimistic-files-store';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { normalizeFilenameToNFC } from '@agentpress/shared';
import { 
  getStreamPreconnectService, 
  storePreconnectInfo 
} from '@/lib/streaming/stream-preconnect';

export interface OptimisticAgentStartOptions {
  message: string;
  modelName?: string;
  agentId?: string;
  /** Mode starter to pass as query param (e.g., 'presentation') */
  modeStarter?: string;
  /** Mode for backend context (slides, sheets, docs, canvas, video, research) */
  mode?: string;
  /** Files to upload with the agent start */
  files?: File[];
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

export interface UseOptimisticAgentStartOptions {
  /** Path to redirect to on error (e.g., '/dashboard' or '/') */
  redirectOnError?: string;
  /** Callback when a background error occurs (e.g., billing limit) - useful for resetting parent loading states */
  onBackgroundError?: () => void;
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
 * @param options - Configuration options for the hook
 */
export function useOptimisticAgentStart(
  options: UseOptimisticAgentStartOptions | string = {}
): UseOptimisticAgentStartReturn {
  // Support legacy string argument for backwards compatibility
  const normalizedOptions = typeof options === 'string'
    ? { redirectOnError: options }
    : options;
  const { redirectOnError = '/dashboard', onBackgroundError } = normalizedOptions;
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

  // Unified handler for all tier restriction errors using shared formatting
  const handleTierError = useCallback((error: any) => {
    const errorUI = formatTierErrorForUI(error);
    if (errorUI) {
      router.replace(redirectOnError);
      pricingModalStore.openPricingModal({
        isAlert: true,
        alertTitle: errorUI.alertTitle,
        alertSubtitle: errorUI.alertSubtitle
      });
      // Notify parent to reset loading states
      onBackgroundError?.();
    }
  }, [router, redirectOnError, pricingModalStore, onBackgroundError]);

  // Special handler for AgentRunLimitError (needs banner, not just modal)
  const handleAgentRunLimitError = useCallback((error: AgentRunLimitError) => {
    console.log('[OptimisticAgentStart] Caught AgentRunLimitError');
    const { running_thread_ids, running_count } = error.detail;
    // Notify parent to reset loading states
    onBackgroundError?.();
    setAgentLimitData({
      runningCount: running_count,
      runningThreadIds: running_thread_ids,
    });
    setShowAgentLimitBanner(true);
    router.replace(redirectOnError);
  }, [router, redirectOnError, onBackgroundError]);

  const startAgent = useCallback(async (
    options: OptimisticAgentStartOptions
  ): Promise<OptimisticAgentStartResult | null> => {
    const { message, modelName, agentId, modeStarter, mode, files } = options;
    
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      toast.error('Please enter a message');
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
        model_name: modelName,
        agent_id: agentId || undefined,
        mode: mode,
        files: files,
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
        
        // Invalidate all relevant queries so the sidebar and thread page pick up the new data
        // Use 'threads' prefix to match ALL threads queries (lists, paginated, etc.)
        // refetchType: 'all' ensures even inactive queries are refetched
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['threads'], refetchType: 'all' }),
          queryClient.invalidateQueries({ queryKey: ['projects'], refetchType: 'all' }),
          queryClient.invalidateQueries({ queryKey: ['active-agent-runs'] }),
          // Also invalidate the thread-specific queries
          queryClient.invalidateQueries({ queryKey: ['thread', threadId] }),
          queryClient.invalidateQueries({ queryKey: ['thread', threadId, 'agent-runs'] }),
          queryClient.invalidateQueries({ queryKey: ['thread', threadId, 'messages'] }),
          queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
        ]);
        // Reset starting state
        setIsStarting(false);
      }).catch((error) => {
        console.error('[OptimisticAgentStart] Background agent start failed:', error);
        setIsStarting(false);
        
        // Clear pending intent on billing/limit errors (user action required)
        // Keep it for network errors so retry can happen
        if (isTierRestrictionError(error)) {
          localStorage.removeItem('pending_thread_intent');
        }
        
        // Handle AgentRunLimitError first (needs special banner handling)
        if (error instanceof AgentRunLimitError) {
          handleAgentRunLimitError(error);
          return;
        }
        
        // Check for error code in case instanceof check fails (fallback for AgentRunLimitError)
        if (error?.detail?.error_code === 'AGENT_RUN_LIMIT_EXCEEDED' || 
            error?.code === 'AGENT_RUN_LIMIT_EXCEEDED' ||
            (error?.status === 402 && error?.detail?.running_count !== undefined)) {
          const running_thread_ids = error.detail?.running_thread_ids || [];
          const running_count = error.detail?.running_count || 0;
          // Notify parent to reset loading states
          onBackgroundError?.();
          setAgentLimitData({
            runningCount: running_count,
            runningThreadIds: running_thread_ids,
          });
          setShowAgentLimitBanner(true);
          router.replace(redirectOnError);
          return;
        }
        
        // Handle all other tier restriction errors using shared formatting
        if (isTierRestrictionError(error)) {
          handleTierError(error);
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
      
      // Handle AgentRunLimitError first (needs special banner handling)
      if (error instanceof AgentRunLimitError) {
        handleAgentRunLimitError(error);
      } else if (isTierRestrictionError(error)) {
        // Handle all other tier restriction errors using shared formatting
        handleTierError(error);
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
    handleTierError,
    handleAgentRunLimitError,
    onBackgroundError,
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

