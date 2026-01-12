'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLeadingDebouncedCallback } from '@/hooks/utils';
import { useOptimisticAgentStart, AgentLimitInfo } from '@/hooks/threads';
import { useAgentSelection } from '@/stores/agent-selection-store';
import { useSunaModePersistence } from '@/stores/suna-modes-store';
import { useAgents } from '@/hooks/agents/use-agents';
import { useAuth } from '@/components/AuthProvider';
import type { ChatInputHandles } from '@/components/thread/chat-input/chat-input';

const PENDING_PROMPT_KEY = 'pendingAgentPrompt';

export interface UseAgentStartInputOptions {
  /** Path to redirect to on error (e.g., '/dashboard' or '/') */
  redirectOnError?: string;
  /** Whether to require authentication before submitting */
  requireAuth?: boolean;
  /** Callback when auth is required but user is not logged in */
  onAuthRequired?: (pendingMessage: string) => void;
  /** Agent limit for fetching (default: 50) */
  agentLimit?: number;
  /** Whether to auto-submit pending prompt from localStorage */
  enableAutoSubmit?: boolean;
  /** Log prefix for debugging */
  logPrefix?: string;
}

export interface UseAgentStartInputReturn {
  // Input state
  inputValue: string;
  setInputValue: (value: string) => void;
  
  // Submit state
  isSubmitting: boolean;
  isRedirecting: boolean;
  isOptimisticStarting: boolean;
  
  // Refs
  chatInputRef: React.RefObject<ChatInputHandles | null>;
  
  // Agent selection
  selectedAgentId: string | null;
  setSelectedAgent: (agentId: string | null) => void;
  agents: any[];
  isLoadingAgents: boolean;
  selectedAgent: any | null;
  isSunaAgent: boolean;
  
  // Suna modes
  selectedMode: any;
  selectedCharts: any;
  selectedOutputFormat: any;
  selectedTemplate: any;
  setSelectedMode: (mode: any) => void;
  setSelectedCharts: (charts: any) => void;
  setSelectedOutputFormat: (format: any) => void;
  setSelectedTemplate: (template: any) => void;
  
  // Agent limit banner
  agentLimitData: AgentLimitInfo | null;
  showAgentLimitBanner: boolean;
  setShowAgentLimitBanner: (show: boolean) => void;
  clearAgentLimitData: () => void;
  
  // Submit handler
  handleSubmit: (
    message: string,
    options?: { model_name?: string; enable_thinking?: boolean; enable_context_manager?: boolean }
  ) => void;
  
  // Router prefetch helpers
  prefetchedRouteRef: React.MutableRefObject<string | null>;
  prefetchTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
}

export function useAgentStartInput(options: UseAgentStartInputOptions = {}): UseAgentStartInputReturn {
  const {
    redirectOnError = '/dashboard',
    requireAuth = true,
    onAuthRequired,
    agentLimit = 50,
    enableAutoSubmit = true,
    logPrefix = '[AgentStartInput]',
  } = options;
  
  const router = useRouter();
  const { user, isLoading: isAuthLoading } = useAuth();
  
  // Input state
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  
  const chatInputRef = useRef<ChatInputHandles>(null);
  const prefetchedRouteRef = useRef<string | null>(null);
  const prefetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Agent selection from store
  const {
    selectedAgentId,
    setSelectedAgent,
    initializeFromAgents,
  } = useAgentSelection();
  
  // Suna modes persistence
  const {
    selectedMode,
    selectedCharts,
    selectedOutputFormat,
    selectedTemplate,
    setSelectedMode,
    setSelectedCharts,
    setSelectedOutputFormat,
    setSelectedTemplate,
  } = useSunaModePersistence();
  
  // Optimistic agent start hook
  const {
    startAgent,
    isStarting: isOptimisticStarting,
    agentLimitData,
    showAgentLimitBanner,
    setShowAgentLimitBanner,
    clearAgentLimitData,
  } = useOptimisticAgentStart(redirectOnError);
  
  // Fetch agents
  const { data: agentsResponse, isLoading: isLoadingAgents } = useAgents({
    limit: agentLimit,
    sort_by: 'name',
    sort_order: 'asc'
  });
  
  const agents = Array.isArray(agentsResponse?.agents) ? agentsResponse.agents : [];
  const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default === true);
  const selectedAgent = selectedAgentId
    ? agents.find(agent => agent.agent_id === selectedAgentId)
    : null;
  
  // Determine if Suna agent is selected (for modes panel)
  const isSunaAgent = isLoadingAgents 
    ? true // Show Kortix modes while loading
    : (selectedAgent?.metadata?.is_suna_default || (!selectedAgentId && sunaAgent !== undefined) || false);
  
  // Initialize agent selection when agents are loaded
  useEffect(() => {
    if (agents.length > 0) {
      initializeFromAgents(agents, undefined, setSelectedAgent);
    }
  }, [agents, initializeFromAgents, setSelectedAgent]);
  
  // Route prefetching on mount
  useEffect(() => {
    const dummyProjectId = 'prefetch-project';
    const dummyThreadId = 'prefetch-thread';
    const routeToPrefetch = `/projects/${dummyProjectId}/thread/${dummyThreadId}`;
    router.prefetch(routeToPrefetch);
    prefetchedRouteRef.current = routeToPrefetch;
  }, [router]);
  
  // Route prefetching when input changes
  useEffect(() => {
    if (inputValue.trim() && !isSubmitting && !isRedirecting) {
      if (prefetchTimeoutRef.current) {
        clearTimeout(prefetchTimeoutRef.current);
      }

      prefetchTimeoutRef.current = setTimeout(() => {
        const dummyProjectId = 'prefetch-project';
        const dummyThreadId = 'prefetch-thread';
        const routeToPrefetch = `/projects/${dummyProjectId}/thread/${dummyThreadId}`;
        
        if (prefetchedRouteRef.current !== routeToPrefetch) {
          router.prefetch(routeToPrefetch);
          prefetchedRouteRef.current = routeToPrefetch;
        }
      }, 300);
    }

    return () => {
      if (prefetchTimeoutRef.current) {
        clearTimeout(prefetchTimeoutRef.current);
      }
    };
  }, [inputValue, isSubmitting, isRedirecting, router]);
  
  // Load pending prompt from localStorage
  useEffect(() => {
    if (!enableAutoSubmit) return;
    
    const timer = setTimeout(() => {
      const pendingPrompt = localStorage.getItem(PENDING_PROMPT_KEY);
      if (pendingPrompt) {
        setInputValue(pendingPrompt);
        setAutoSubmit(true);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [enableAutoSubmit]);
  
  // Submit handler - unified logic for both hero and dashboard
  const handleSubmit = useLeadingDebouncedCallback(async (
    message: string,
    options?: { model_name?: string; enable_thinking?: boolean; enable_context_manager?: boolean }
  ) => {
    const fileIds = chatInputRef.current?.getUploadedFileIds() || [];

    if ((!message.trim() && !fileIds.length) || isSubmitting || isRedirecting || isOptimisticStarting) {
      return;
    }
    
    // Check auth if required
    if (requireAuth && !user && !isAuthLoading) {
      localStorage.setItem(PENDING_PROMPT_KEY, message.trim());
      onAuthRequired?.(message.trim());
      return;
    }

    setIsSubmitting(true);
    setIsRedirecting(true);
    localStorage.removeItem(PENDING_PROMPT_KEY);

    console.log(`${logPrefix} Starting agent with:`, {
      prompt: message.substring(0, 100),
      promptLength: message.length,
      model_name: options?.model_name,
      agent_id: selectedAgentId,
      fileIds: fileIds.length,
    });

    const result = await startAgent({
      message,
      fileIds: fileIds.length > 0 ? fileIds : undefined,
      modelName: options?.model_name,
      agentId: selectedAgentId || undefined,
    });

    if (!result) {
      // Error was handled by the hook, reset state
      chatInputRef.current?.clearPendingFiles();
      setIsSubmitting(false);
      setIsRedirecting(false);
    }
  }, 1200);
  
  // Auto-submit when pending prompt is loaded
  useEffect(() => {
    if (autoSubmit && inputValue && !isSubmitting && !isRedirecting && user) {
      const timer = setTimeout(() => {
        handleSubmit(inputValue);
        setAutoSubmit(false);
      }, 500);

      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoSubmit, inputValue, isSubmitting, isRedirecting, handleSubmit, user]);
  
  return {
    // Input state
    inputValue,
    setInputValue,
    
    // Submit state
    isSubmitting,
    isRedirecting,
    isOptimisticStarting,
    
    // Refs
    chatInputRef,
    
    // Agent selection
    selectedAgentId,
    setSelectedAgent,
    agents,
    isLoadingAgents,
    selectedAgent,
    isSunaAgent,
    
    // Suna modes
    selectedMode,
    selectedCharts,
    selectedOutputFormat,
    selectedTemplate,
    setSelectedMode,
    setSelectedCharts,
    setSelectedOutputFormat,
    setSelectedTemplate,
    
    // Agent limit banner
    agentLimitData,
    showAgentLimitBanner,
    setShowAgentLimitBanner,
    clearAgentLimitData,
    
    // Submit handler
    handleSubmit,
    
    // Router prefetch helpers
    prefetchedRouteRef,
    prefetchTimeoutRef,
  };
}

