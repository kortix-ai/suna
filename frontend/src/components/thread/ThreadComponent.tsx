'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { 
  AgentRunLimitError, 
  ProjectLimitError, 
  BillingError 
} from '@/lib/api/errors';
import { toast } from 'sonner';
import { ChatInput, ChatInputHandles } from '@/components/thread/chat-input/chat-input';
import { SidebarContext } from '@/components/ui/sidebar';
import { useAgentStream } from '@/hooks/messages';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/utils';
import { isLocalMode } from '@/lib/config';
import { ThreadContent } from '@/components/thread/content/ThreadContent';
import { ThreadSkeleton } from '@/components/thread/content/ThreadSkeleton';
import { PlaybackFloatingControls } from '@/components/thread/content/PlaybackFloatingControls';
import { usePlaybackController, useAddUserMessageMutation } from '@/hooks/messages';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import {
  useStartAgentMutation,
  useStopAgentMutation,
} from '@/hooks/threads/use-agent-run';
import { useSharedSubscription } from '@/stores/subscription-store';
import { useAuth } from '@/components/AuthProvider';
export type SubscriptionStatus = 'no_subscription' | 'active';

import {
  UnifiedMessage,
  ApiMessageType,
} from '@/components/thread/types';
import {
  useThreadData,
  useThreadBilling,
  useThreadKeyboardShortcuts,
} from '@/hooks/threads/page';
import { useThreadToolCalls } from '@/hooks/messages';
import { ThreadError, ThreadLayout } from '@/components/thread/layout';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { useBillingModal } from '@/hooks/billing/use-billing-modal';

import {
  useAgents,
} from '@/hooks/agents/use-agents';
import { AgentRunLimitBanner } from '@/components/thread/agent-run-limit-banner';
import { 
  useSelectedAgentId, 
  useSetSelectedAgent, 
  useInitializeFromAgents, 
  useGetCurrentAgent, 
  useIsSunaAgentFn 
} from '@/stores/agent-selection-store';
import { useQueryClient } from '@tanstack/react-query';
import { threadKeys } from '@/hooks/threads/keys';
import { fileQueryKeys } from '@/hooks/files';
import { useProjectRealtime } from '@/hooks/threads';
import { handleGoogleSlidesUpload } from './tool-views/utils/presentation-utils';
import { useTranslations } from 'next-intl';
import { useKortixComputerStore, useSetIsSidePanelOpen } from '@/stores/kortix-computer-store';
import { useToolStreamStore } from '@/stores/tool-stream-store';
import { useOptimisticFilesStore } from '@/stores/optimistic-files-store';
import { useProcessStreamOperation } from '@/stores/spreadsheet-store';
import { uploadPendingFilesToProject } from '@/components/thread/chat-input/file-upload-handler';

interface ThreadComponentProps {
  projectId: string;
  threadId: string;
  compact?: boolean;
  configuredAgentId?: string;
  isShared?: boolean;
}

export function ThreadComponent({ projectId, threadId, compact = false, configuredAgentId, isShared = false }: ThreadComponentProps) {
  const t = useTranslations('dashboard');
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const { user } = useAuth();
  const isAuthenticated = !!user;
  
  const isNewThread = searchParams?.get('new') === 'true';

  const [isSending, setIsSending] = useState(false);
  const [initialPanelOpenAttempted, setInitialPanelOpenAttempted] =
    useState(false);
  const storeSelectedAgentId = useSelectedAgentId();
  const storeSetSelectedAgent = useSetSelectedAgent();
  const storeInitializeFromAgents = useInitializeFromAgents();
  const storeGetCurrentAgent = useGetCurrentAgent();
  const storeIsSunaAgentFn = useIsSunaAgentFn();
  
  const agentsQuery = useAgents({}, { enabled: isAuthenticated && !isShared });

  const selectedAgentId = isShared ? undefined : storeSelectedAgentId;
  const setSelectedAgent = isShared ? (() => { }) : storeSetSelectedAgent;
  const initializeFromAgents = isShared ? (() => { }) : storeInitializeFromAgents;
  const getCurrentAgent = isShared ? (() => undefined) : storeGetCurrentAgent;
  const isSunaAgent = isShared ? false : storeIsSunaAgentFn;

  // Memoize agents array to prevent unnecessary recalculations
  const agents = useMemo(() => {
    if (isShared) return [];
    return agentsQuery?.data?.agents || [];
  }, [isShared, agentsQuery?.data?.agents]);
  const [isSidePanelAnimating, setIsSidePanelAnimating] = useState(false);
  const [userInitiatedRun, setUserInitiatedRun] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
  const [showAgentLimitBanner, setShowAgentLimitBanner] = useState(false);
  const [agentLimitData, setAgentLimitData] = useState<{
    runningCount: number;
    runningThreadIds: string[];
  } | null>(null);

  const latestMessageRef = useRef<HTMLDivElement>(null);
  const initialLayoutAppliedRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastStreamStartedRef = useRef<string | null>(null);
  const pendingMessageRef = useRef<string | null>(null);
  const chatInputRef = useRef<ChatInputHandles>(null);

  const hasActiveSelection = useCallback((): boolean => {
    const selection = window.getSelection();
    return selection !== null && selection.toString().trim().length > 0;
  }, []);

  const queueMessage = useMessageQueueStore((state) => state.queueMessage);
  const removeQueuedMessage = useMessageQueueStore((state) => state.removeMessage);
  const clearQueue = useMessageQueueStore((state) => state.clearQueue);
  const allQueuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  
  const queuedMessages = useMemo(() => 
    allQueuedMessages.filter((msg) => msg.threadId === threadId),
    [allQueuedMessages, threadId]
  );

  const sidebarContext = React.useContext(SidebarContext);
  const leftSidebarState: 'expanded' | 'collapsed' | undefined = sidebarContext?.state;
  const setLeftSidebarOpen: ((open: boolean) => void) | undefined = sidebarContext?.setOpen;

  const hasDataLoaded = useRef(false);
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(null);
  const [showOptimisticUI, setShowOptimisticUI] = useState(false);
  const setStorePanelOpen = useSetIsSidePanelOpen();
  
  const allOptimisticFiles = useOptimisticFilesStore((state) => state.files);
  const updateFileStatus = useOptimisticFilesStore((state) => state.updateFileStatus);
  const clearOptimisticFiles = useOptimisticFilesStore((state) => state.clearFilesForThread);
  const optimisticFiles = useMemo(
    () => allOptimisticFiles.filter((f) => f.threadId === threadId),
    [allOptimisticFiles, threadId]
  );
  const [optimisticFilesUploading, setOptimisticFilesUploading] = useState(false);
  const optimisticFilesUploadedRef = useRef(false);
  
  const {
    messages,
    setMessages,
    project,
    sandboxId,
    projectName,
    agentRunId,
    setAgentRunId,
    agentStatus,
    setAgentStatus,
    isLoading,
    error,
    initialLoadCompleted,
    threadQuery,
    messagesQuery,
    projectQuery,
    agentRunsQuery,
  } = useThreadData(threadId, projectId, isShared, {
    waitingForAgent: isNewThread && !hasDataLoaded.current,
  });
  
  const threadStatus = threadQuery.data?.status;
  const threadInitializationError = threadQuery.data?.initialization_error;
  
  const isThreadInitializing = false;

  const {
    toolCalls,
    setToolCalls,
    currentToolIndex,
    setCurrentToolIndex,
    isSidePanelOpen,
    setIsSidePanelOpen,
    autoOpenedPanel,
    setAutoOpenedPanel,
    externalNavIndex,
    setExternalNavIndex,
    handleToolClick,
    handleStreamingToolCall,
    toggleSidePanel,
    handleSidePanelNavigate,
    userClosedPanelRef,
  } = useThreadToolCalls(messages, setLeftSidebarOpen, agentStatus, compact);
  
  if (isNewThread && !optimisticPrompt) {
    try {
      const stored = sessionStorage.getItem('optimistic_prompt');
      const storedThread = sessionStorage.getItem('optimistic_thread');
      if (stored && storedThread === threadId) {
        setOptimisticPrompt(stored);
        setShowOptimisticUI(true);
        if (!isMobile && !compact) {
          setStorePanelOpen(true);
        }
        sessionStorage.removeItem('optimistic_prompt');
        sessionStorage.removeItem('optimistic_thread');
      }
    } catch (e) {
    }
  }
  
  useEffect(() => {
    if (isNewThread && !hasDataLoaded.current && agentRunId) {
      hasDataLoaded.current = true;
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        if (url.searchParams.get('new') === 'true') {
          url.searchParams.delete('new');
          window.history.replaceState({}, '', url.pathname + url.search);
        }
      }
    }
  }, [isNewThread, agentRunId]);
  
  const shouldHideOptimisticUI = isNewThread 
    ? (agentRunId && initialLoadCompleted)
    : ((agentRunId || messages.length > 0 || threadStatus === 'ready') && initialLoadCompleted);
  
  useEffect(() => {
    if (shouldHideOptimisticUI && showOptimisticUI) {
      setShowOptimisticUI(false);
    }
  }, [shouldHideOptimisticUI, showOptimisticUI]);
  
  const effectivePanelOpen = isSidePanelOpen || (isNewThread && showOptimisticUI);

  const handleSidePanelClose = useCallback(() => {
    setIsSidePanelOpen(false);
    userClosedPanelRef.current = true;
    setAutoOpenedPanel(true);
  }, [setIsSidePanelOpen, setAutoOpenedPanel]);

  // Use individual selectors to avoid subscribing to entire store (prevents unnecessary re-renders)
  const openFileInComputer = useKortixComputerStore((state) => state.openFileInComputer);
  const openFileBrowser = useKortixComputerStore((state) => state.openFileBrowser);
  const resetKortixComputerStore = useKortixComputerStore((state) => state.reset);

  const billingModal = useBillingModal();
  const threadBilling = useThreadBilling(
    null,
    agentStatus,
    initialLoadCompleted,
    () => {
      billingModal.openModal();
    },
    isAuthenticated && !isShared
  );

  const {
    showModal: showBillingModal,
    creditsExhausted,
    openModal: openBillingModal,
    closeModal: closeBillingModal,
  } = isShared ? {
    showModal: false,
    creditsExhausted: false,
    openModal: () => { },
    closeModal: () => { },
  } : billingModal;

  const {
    checkBillingLimits,
  } = isShared ? {
    checkBillingLimits: async () => false,
  } : threadBilling;

  useProjectRealtime(projectId);
  useThreadKeyboardShortcuts({
    isSidePanelOpen,
    setIsSidePanelOpen,
    leftSidebarState,
    setLeftSidebarOpen,
    userClosedPanelRef,
  });

  const addUserMessageMutation = useAddUserMessageMutation();
  const startAgentMutation = useStartAgentMutation();
  const stopAgentMutation = useStopAgentMutation();

  // Extract stable primitive values to avoid infinite loops
  // Optimize: search from end instead of reversing entire array (important for large message arrays)
  const derivedAgentId = useMemo(() => {
    if (isShared) return undefined;
    
    // Search from the end backwards to find most recent assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === "assistant" && (msg.agents?.name || msg.agent_id)) {
        return msg.agent_id;
      }
    }
    
    return undefined;
  }, [messages, isShared]);

  const derivedAgentName = useMemo(() => {
    if (isShared) return undefined;
    
    // Search from the end backwards to find most recent assistant message
    let recentAssistantMessage: UnifiedMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === "assistant" && (msg.agents?.name || msg.agent_id)) {
        recentAssistantMessage = msg;
        break;
      }
    }
    
    if (!recentAssistantMessage) return undefined;
    
    const agentNameFromMessage = recentAssistantMessage.agents?.name;
    const agentIdFromMessage = recentAssistantMessage.agent_id;
    
    // Find agent name from agents list if we have an agent_id but no name from message
    if (agentIdFromMessage && !agentNameFromMessage && agents.length > 0) {
      const foundAgent = agents.find(a => a.agent_id === agentIdFromMessage);
      return foundAgent?.name;
    }
    
    return agentNameFromMessage;
  }, [messages, agents, isShared]);

  // Keep derivedAgentInfo for backward compatibility with existing code
  const derivedAgentInfo = useMemo(() => ({
    agentId: derivedAgentId,
    agentName: derivedAgentName,
  }), [derivedAgentId, derivedAgentName]);

  useEffect(() => {
    if (!isShared) {
      queryClient.invalidateQueries({ queryKey: threadKeys.agentRuns(threadId) });
      queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) });
      resetKortixComputerStore();
    }
  }, [threadId, queryClient, isShared, resetKortixComputerStore]);

  useEffect(() => {
    if (!isNewThread || hasDataLoaded.current || !showOptimisticUI) return;
    
    const timeoutId = setTimeout(() => {
      if (!hasDataLoaded.current && showOptimisticUI) {
        console.warn('[ThreadComponent] Polling timeout reached, no agent detected after 30s');
        hasDataLoaded.current = true;
        setShowOptimisticUI(false);
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href);
          if (url.searchParams.get('new') === 'true') {
            url.searchParams.delete('new');
            window.history.replaceState({}, '', url.pathname + url.search);
          }
        }
        toast.error('Failed to start the conversation. Please try again.');
      }
    }, 30000);
    
    return () => clearTimeout(timeoutId);
  }, [isNewThread, showOptimisticUI]);

  useEffect(() => {
    const handleSandboxActive = (event: Event) => {
      const customEvent = event as CustomEvent<{ sandboxId: string; projectId: string }>;
      const { sandboxId, projectId: eventProjectId } = customEvent.detail;
      if (eventProjectId === projectId) {
        queryClient.invalidateQueries({
          queryKey: fileQueryKeys.contents()
        });
      }
    };

    window.addEventListener('sandbox-active', handleSandboxActive);
    return () => window.removeEventListener('sandbox-active', handleSandboxActive);
  }, [projectId, queryClient]);

  useEffect(() => {
    if (
      optimisticFilesUploadedRef.current ||
      optimisticFilesUploading ||
      optimisticFiles.length === 0
    ) {
      return;
    }

    const pendingFiles = optimisticFiles.filter((f) => f.status === 'pending');
    if (pendingFiles.length === 0) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;

    const uploadFiles = async () => {
      setOptimisticFilesUploading(true);
      optimisticFilesUploadedRef.current = true;

      pendingFiles.forEach((f) => updateFileStatus(f.id, 'uploading'));

      const files = pendingFiles.map((f) => f.file);
      
      try {
        await uploadPendingFilesToProject(files, projectId, (fileIndex, status, error) => {
          const file = pendingFiles[fileIndex];
          if (file) {
            updateFileStatus(file.id, status, error);
          }
        });
        
        // Only clear files if component is still mounted
        if (isMounted) {
          timeoutId = setTimeout(() => {
            if (isMounted) {
              clearOptimisticFiles(threadId);
              sessionStorage.removeItem('optimistic_files');
            }
          }, 2000);
        }
      } catch (error) {
        console.error('Failed to upload optimistic files:', error);
        if (isMounted) {
          pendingFiles.forEach((f) => updateFileStatus(f.id, 'error', 'Upload failed'));
        }
      } finally {
        if (isMounted) {
          setOptimisticFilesUploading(false);
        }
      }
    };

    uploadFiles();

    return () => {
      isMounted = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [
    optimisticFiles,
    optimisticFilesUploading,
    projectId,
    threadId,
    updateFileStatus,
    clearOptimisticFiles,
  ]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);

    if (urlParams.get('google_auth') === 'success') {
      window.history.replaceState({}, '', window.location.pathname);
      const uploadIntent = sessionStorage.getItem('google_slides_upload_intent');
      if (uploadIntent) {
        sessionStorage.removeItem('google_slides_upload_intent');

        try {
          const uploadData = JSON.parse(uploadIntent);
          const { presentation_path, sandbox_url } = uploadData;

          if (presentation_path && sandbox_url) {
            (async () => {
              const uploadPromise = handleGoogleSlidesUpload(
                sandbox_url,
                presentation_path
              );

              const loadingToast = toast.loading('Google authentication successful! Uploading presentation...');

              try {
                await uploadPromise;
              } catch (error) {
                console.error('Upload failed:', error);
              } finally {
                toast.dismiss(loadingToast);
              }
            })();
          }
        } catch (error) {
          console.error('Error processing Google Slides upload from session:', error);
        }
      } else {
        toast.success('Google authentication successful!');
      }
    } else if (urlParams.get('google_auth') === 'error') {
      const error = urlParams.get('error');
      sessionStorage.removeItem('google_slides_upload_intent');
      window.history.replaceState({}, '', window.location.pathname);
      toast.error(`Google authentication failed: ${error || 'Unknown error'}`);
    }
  }, []);

  // Track previous agentId to prevent unnecessary effect runs
  const prevAgentIdRef = useRef<string | undefined>(undefined);
  const prevAgentsLengthRef = useRef<number>(0);
  
  useEffect(() => {
    if (agents.length === 0) return;
    
    const agentIdToUse = configuredAgentId || derivedAgentId;
    
    // Only run if agentId actually changed or agents array length changed
    // This prevents infinite loops when agents array reference changes but content is the same
    if (
      agentIdToUse === prevAgentIdRef.current && 
      agents.length === prevAgentsLengthRef.current &&
      selectedAgentId === configuredAgentId
    ) {
      return; // No actual change, skip effect
    }
    
    prevAgentIdRef.current = agentIdToUse;
    prevAgentsLengthRef.current = agents.length;
    
    initializeFromAgents(agents, agentIdToUse);
    if (configuredAgentId && selectedAgentId !== configuredAgentId) {
      setSelectedAgent(configuredAgentId);
    }
  }, [derivedAgentId, agents, initializeFromAgents, configuredAgentId, selectedAgentId, setSelectedAgent]);

  const sharedSubscription = useSharedSubscription();
  const { data: subscriptionData } = isShared ? { data: undefined } : sharedSubscription;
  const subscriptionStatus: SubscriptionStatus =
    subscriptionData?.status === 'active' ||
      subscriptionData?.status === 'trialing'
      ? 'active'
      : 'no_subscription';

  const handleProjectRenamed = useCallback((newName: string) => { }, []);

  const handleAgentSelect = useCallback((agentId: string | undefined) => {
    if (configuredAgentId) {
      if (agentId === configuredAgentId) {
        setSelectedAgent(agentId);
      }
      return;
    }
    setSelectedAgent(agentId);
  }, [configuredAgentId, setSelectedAgent]);

  const scrollToBottom = useCallback(() => {
    if (hasActiveSelection()) return;
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [hasActiveSelection]);

  const handlePromptFill = useCallback((message: string) => {
    chatInputRef.current?.setValue(message);
  }, []);

  const handleExpandToolPreview = useCallback(() => {
    setIsSidePanelOpen(true);
    userClosedPanelRef.current = false;
  }, [setIsSidePanelOpen]);

  const handleNewMessageFromStream = useCallback(
    (message: UnifiedMessage) => {
      setMessages((prev) => {
        const messageExists = prev.some(
          (m) => m.message_id === message.message_id,
        );
        if (messageExists) {
          return prev.map((m) =>
            m.message_id === message.message_id ? message : m,
          );
        } else {
          if (message.type === 'user') {
            const optimisticIndex = prev.findIndex(
              (m) =>
                m.type === 'user' &&
                m.message_id?.startsWith('temp-') &&
                m.content === message.content,
            );
            if (optimisticIndex !== -1) {
              return prev.map((m, index) =>
                index === optimisticIndex ? message : m,
              );
            }
          }
          return [...prev, message];
        }
      });

      if (message.type === 'tool') {
        setAutoOpenedPanel(false);
      }

      setTimeout(() => {
        if (hasActiveSelection()) return;
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }, 100);
    },
    [setMessages, setAutoOpenedPanel, hasActiveSelection],
  );

  const handleStreamStatusChange = useCallback(
    (hookStatus: string) => {
      switch (hookStatus) {
        case 'idle':
        case 'completed':
        case 'stopped':
        case 'agent_not_running':
        case 'error':
        case 'failed':
          setAgentStatus('idle');
          setAgentRunId(null);
          setAutoOpenedPanel(false);

          const ENABLE_MESSAGE_QUEUE = false;
          if (ENABLE_MESSAGE_QUEUE && queuedMessages.length > 0) {
            console.log('[ThreadComponent] Agent stopped, will send queued messages:', queuedMessages.length);
            setTimeout(() => {
              const firstMessage = queuedMessages[0];
              if (firstMessage) {
                removeQueuedMessage(firstMessage.id);
                handleSubmitMessage(firstMessage.message, firstMessage.options);
              }
            }, 500);
          }

          break;
        case 'connecting':
          setAgentStatus('connecting');

          if (pendingMessageRef.current) {
            const optimisticUserMessage: UnifiedMessage = {
              message_id: `temp-${Date.now()}`,
              thread_id: threadId,
              type: 'user',
              is_llm_message: false,
              content: pendingMessageRef.current,
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            setMessages((prev) => [...prev, optimisticUserMessage]);
            pendingMessageRef.current = null;

            setTimeout(() => {
              if (hasActiveSelection()) return;
              if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }, 100);
          }
          break;
        case 'streaming':
          setAgentStatus('running');
          break;
      }
    },
    [setAgentStatus, setAgentRunId, setAutoOpenedPanel, threadId, setMessages, queuedMessages, removeQueuedMessage, hasActiveSelection],
  );

  const handleStreamError = useCallback((errorMessage: string) => {
    const lower = errorMessage.toLowerCase();
    const isExpected =
      lower.includes('not found') || lower.includes('agent run is not running');

    const isBillingError =
      lower.includes('insufficient credits') ||
      lower.includes('credit') ||
      lower.includes('balance') ||
      lower.includes('out of credits') ||
      lower.includes('no credits');

    if (isBillingError) {
      console.error(`[PAGE] Agent stopped due to billing error: ${errorMessage}`);
      const billingError = new BillingError(402, {
        message: errorMessage,
      });
      openBillingModal(billingError);
      pendingMessageRef.current = null;
      return;
    }

    if (isExpected) {
      return;
    }

    console.error(`[PAGE] Stream hook error: ${errorMessage}`);
    toast.error(`Stream Error: ${errorMessage}`);

    pendingMessageRef.current = null;
  }, [openBillingModal]);

  const handleStreamClose = useCallback(() => { }, []);

  // Use individual selectors to avoid subscribing to entire store (prevents unnecessary re-renders)
  const appendOutput = useToolStreamStore((state) => state.appendOutput);
  const markComplete = useToolStreamStore((state) => state.markComplete);
  const processSpreadsheetOperation = useProcessStreamOperation();
  
  const handleToolOutputStream = useCallback((data: { 
    tool_call_id: string; 
    tool_name: string; 
    output: string; 
    is_final: boolean; 
  }) => {
    if (data.tool_name === 'spreadsheet' && data.output) {
      try {
        const operation = JSON.parse(data.output);
        if (operation.type === 'spreadsheet_operation') {
          processSpreadsheetOperation(operation);
        }
      } catch (e) {
      }
    }
    
    if (data.output) {
      appendOutput(data.tool_call_id, data.output);
    }
    if (data.is_final) {
      markComplete(data.tool_call_id);
    }
  }, [appendOutput, markComplete, processSpreadsheetOperation]);

  const streamCallbacks = useMemo(() => ({
    onMessage: handleNewMessageFromStream,
    onStatusChange: handleStreamStatusChange,
    onError: handleStreamError,
    onClose: handleStreamClose,
    onToolCallChunk: handleStreamingToolCall,
    onToolOutputStream: handleToolOutputStream,
  }), [handleNewMessageFromStream, handleStreamStatusChange, handleStreamError, handleStreamClose, handleStreamingToolCall, handleToolOutputStream]);

  const {
    status: streamHookStatus,
    textContent: streamingTextContent,
    toolCall: streamingToolCall,
    error: streamError,
    agentRunId: currentHookRunId,
    startStreaming,
    stopStreaming,
  } = useAgentStream(
    streamCallbacks,
    threadId,
    setMessages,
    derivedAgentId,
  );

  const handleSubmitMessage = useCallback(
    async (
      message: string,
      options?: { model_name?: string; file_ids?: string[] },
    ) => {
      if (!message.trim() || isShared || !addUserMessageMutation || !startAgentMutation) return;

      // Message queue feature flag - when disabled, don't queue messages while agent is running
      const ENABLE_MESSAGE_QUEUE = false;
      if (ENABLE_MESSAGE_QUEUE && (agentStatus === 'running' || agentStatus === 'connecting')) {
        const queuedId = queueMessage(threadId, message, {
          ...options,
          agent_id: selectedAgentId,
        });
        chatInputRef.current?.setValue('');
        return;
      }
      
      if (agentStatus === 'running' || agentStatus === 'connecting') {
        return;
      }

      setIsSending(true);
      pendingMessageRef.current = message;

      try {
        const messagePromise = addUserMessageMutation.mutateAsync({
          threadId,
          message,
        });

        const agentPromise = startAgentMutation.mutateAsync({
          threadId,
          options: {
            ...options,
            agent_id: selectedAgentId,
            file_ids: options?.file_ids,
          },
        });

        const results = await Promise.allSettled([
          messagePromise,
          agentPromise,
        ]);

        if (results[0].status === 'rejected') {
          const reason = results[0].reason;
          console.error('Failed to send message:', reason);
          pendingMessageRef.current = null;
          throw new Error(
            `Failed to send message: ${reason?.message || reason}`,
          );
        }

        if (results[1].status === 'rejected') {
          const error = results[1].reason;
          console.error('Failed to start agent:', error);
          pendingMessageRef.current = null;

          if (error instanceof BillingError) {
            openBillingModal(error);
            return;
          }

          if (error instanceof AgentRunLimitError) {
            const { running_thread_ids, running_count } = error.detail;

            setAgentLimitData({
              runningCount: running_count,
              runningThreadIds: running_thread_ids,
            });
            setShowAgentLimitBanner(true);
            return;
          }

          if (error instanceof ProjectLimitError) {
            openBillingModal(error);
            return;
          }

          throw new Error(`Failed to start agent: ${error?.message || error}`);
        }

        // Clear input text and uploaded files after successful submission
        chatInputRef.current?.setValue('');
        chatInputRef.current?.clearUploadedFiles();

        const agentResult = results[1].value;
        setUserInitiatedRun(true);
        setAgentRunId(agentResult.agent_run_id);
      } catch (err) {
        console.error('Error sending message or starting agent:', err);
        if (
          !(err instanceof BillingError) &&
          !(err instanceof AgentRunLimitError)
        ) {
          toast.error(err instanceof Error ? err.message : 'Operation failed');
        }
      } finally {
        setIsSending(false);
      }
    },
    [
      threadId,
      project?.account_id,
      addUserMessageMutation,
      startAgentMutation,
      setMessages,
      openBillingModal,
      setAgentRunId,
      isShared,
      selectedAgentId,
      agentStatus,
      queueMessage,
      queuedMessages,
    ],
  );

  const handleStopAgent = useCallback(async () => {
    if (isShared) return;

    setAgentStatus('idle');

    await stopStreaming();

    if (agentRunId && stopAgentMutation) {
      try {
        await stopAgentMutation.mutateAsync(agentRunId);
      } catch (error) {
        console.error('Error stopping agent:', error);
      }
    }
  }, [stopStreaming, agentRunId, stopAgentMutation, setAgentStatus, isShared]);


  const handleOpenFileViewer = useCallback(
    (filePath?: string, filePathList?: string[]) => {
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: threadKeys.project(projectId),
          refetchType: 'active',
        });
      }

      if (filePath) {
        openFileInComputer(filePath, filePathList);
        if (!isSidePanelOpen) {
          toggleSidePanel();
        }
      } else {
        openFileInComputer('/workspace');
        if (!isSidePanelOpen) {
          toggleSidePanel();
        }
      }
    },
    [projectId, queryClient, openFileInComputer, isSidePanelOpen, toggleSidePanel],
  );

  const toolViewAssistant = useCallback(
    (assistantContent?: string, toolContent?: string) => {
      if (!assistantContent) return null;

      return (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            Assistant Message
          </div>
          <div className="rounded-md border bg-muted/50 p-3">
            <div className="text-xs prose prose-xs dark:prose-invert chat-markdown max-w-none">
              {assistantContent}
            </div>
          </div>
        </div>
      );
    },
    [],
  );

  const toolViewResult = useCallback(
    (toolContent?: string, isSuccess?: boolean) => {
      if (!toolContent) return null;

      return (
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div className="text-xs font-medium text-muted-foreground">
              Tool Result
            </div>
            <div
              className={`px-2 py-0.5 rounded-full text-xs ${isSuccess
                ? 'bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-300'
                }`}
            >
              {isSuccess ? 'Success' : 'Failed'}
            </div>
          </div>
          <div className="rounded-md border bg-muted/50 p-3">
            <div className="text-xs prose prose-xs dark:prose-invert chat-markdown max-w-none">
              {toolContent}
            </div>
          </div>
        </div>
      );
    },
    [],
  );

  const playback = usePlaybackController({
    messages,
    enabled: isShared,
    isSidePanelOpen,
    onToggleSidePanel: toggleSidePanel,
    setCurrentToolIndex,
    toolCalls,
  });

  useEffect(() => {
    if (!initialLayoutAppliedRef.current) {
      setLeftSidebarOpen?.(false);
      initialLayoutAppliedRef.current = true;
    }
  }, [setLeftSidebarOpen]);
  
  useEffect(() => {
    if (initialLoadCompleted && !initialPanelOpenAttempted) {
      setInitialPanelOpenAttempted(true);
      if (!isMobile && !compact && !isSidePanelOpen) {
        if (toolCalls.length > 0) {
          setIsSidePanelOpen(true);
          setCurrentToolIndex(toolCalls.length - 1);
        } else if (messages.length > 0) {
          setIsSidePanelOpen(true);
        }
      }
    }
  }, [
    initialPanelOpenAttempted,
    messages,
    toolCalls,
    initialLoadCompleted,
    setIsSidePanelOpen,
    setCurrentToolIndex,
    isMobile,
    compact,
    isSidePanelOpen,
  ]);

  useEffect(() => {
    if (agentRunId && lastStreamStartedRef.current === agentRunId) {
      return;
    }

    const shouldAutoStart = userInitiatedRun || isNewThread;

    // Debug logging for stream connection
    if (process.env.NODE_ENV !== 'production' && agentRunId) {
      console.log('[ThreadComponent] Stream effect triggered:', {
        agentRunId,
        currentHookRunId,
        shouldAutoStart,
        userInitiatedRun,
        isNewThread,
        initialLoadCompleted,
        agentStatus,
      });
    }

    if (agentRunId && agentRunId !== currentHookRunId && shouldAutoStart) {
      console.log('[ThreadComponent] Starting stream for new thread:', agentRunId);
      startStreaming(agentRunId);
      lastStreamStartedRef.current = agentRunId;
      setUserInitiatedRun(false);
      return;
    }

    if (
      agentRunId &&
      agentRunId !== currentHookRunId &&
      initialLoadCompleted &&
      !shouldAutoStart &&
      agentStatus === 'running'
    ) {
      console.log('[ThreadComponent] Starting stream for existing thread:', agentRunId);
      startStreaming(agentRunId);
      lastStreamStartedRef.current = agentRunId;
    }
  }, [
    agentRunId,
    startStreaming,
    currentHookRunId,
    initialLoadCompleted,
    userInitiatedRun,
    agentStatus,
    isNewThread,
  ]);

  useEffect(() => {
    if (
      (streamHookStatus === 'completed' ||
        streamHookStatus === 'stopped' ||
        streamHookStatus === 'agent_not_running' ||
        streamHookStatus === 'error') &&
      (agentStatus === 'running' || agentStatus === 'connecting')
    ) {
      setAgentStatus('idle');
      setAgentRunId(null);
      lastStreamStartedRef.current = null;
    }
  }, [streamHookStatus, agentStatus, setAgentStatus, setAgentRunId]);

  useEffect(() => {
    lastStreamStartedRef.current = null;
  }, [threadId]);

  useEffect(() => {
    if (initialLoadCompleted) {
      sessionStorage.removeItem('optimistic_prompt');
      sessionStorage.removeItem('optimistic_thread');
    }
  }, [initialLoadCompleted]);

  // SEO title update
  useEffect(() => {
    if (projectName) {
      document.title = `${projectName} | Kortix`;

      const metaDescription = document.querySelector(
        'meta[name="description"]',
      );
      if (metaDescription) {
        metaDescription.setAttribute(
          'content',
          `${projectName} - Interactive Worker conversation powered by Kortix`,
        );
      }

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        ogTitle.setAttribute('content', `${projectName} | Kortix`);
      }

      const ogDescription = document.querySelector(
        'meta[property="og:description"]',
      );
      if (ogDescription) {
        ogDescription.setAttribute(
          'content',
          `Interactive AI conversation for ${projectName}`,
        );
      }
    }
  }, [projectName]);

  const hasCheckedUpgradeDialog = useRef(false);

  useEffect(() => {
    if (
      initialLoadCompleted &&
      subscriptionData &&
      !hasCheckedUpgradeDialog.current
    ) {
      hasCheckedUpgradeDialog.current = true;
      const hasSeenUpgradeDialog = localStorage.getItem(
        'suna_upgrade_dialog_displayed',
      );
      const isFreeTier = subscriptionStatus === 'no_subscription';
      if (!hasSeenUpgradeDialog && isFreeTier && !isLocalMode()) {
        openBillingModal();
      }
    }
  }, [subscriptionData, subscriptionStatus, initialLoadCompleted, openBillingModal]);


  // Note: handleStreamingToolCall is called via the onToolCallChunk callback in useAgentStream
  // No need for a separate useEffect here - it would cause duplicate processing

  useEffect(() => {
    setIsSidePanelAnimating(true);
    const timer = setTimeout(() => setIsSidePanelAnimating(false), 200); // Match transition duration
    return () => clearTimeout(timer);
  }, [isSidePanelOpen]);

  useEffect(() => {
    if (!initialLoadCompleted) return;

    let rafId: number | null = null;
    let lastScrollCheck = 0;
    const SCROLL_CHECK_THROTTLE = 100;

    const checkScrollPosition = () => {
      const now = Date.now();
      if (now - lastScrollCheck < SCROLL_CHECK_THROTTLE) {
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            checkScrollPosition();
          });
        }
        return;
      }
      lastScrollCheck = now;

      if (!scrollContainerRef.current) {
        setShowScrollToBottom(false);
        return;
      }

      const scrollTop = scrollContainerRef.current.scrollTop;
      const scrollHeight = scrollContainerRef.current.scrollHeight;
      const clientHeight = scrollContainerRef.current.clientHeight;
      const threshold = 50;

      const isScrolledUp = scrollTop < -threshold;
      const hasScrollableContent = scrollHeight > clientHeight;
      const shouldShow = isScrolledUp && hasScrollableContent;

      setShowScrollToBottom(shouldShow);
    };

    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      setShowScrollToBottom(false);
      return;
    }

    scrollContainer.addEventListener('scroll', checkScrollPosition, {
      passive: true,
    });

    const timeout = setTimeout(checkScrollPosition, 100);

    return () => {
      scrollContainer.removeEventListener('scroll', checkScrollPosition);
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(timeout);
    };
  }, [initialLoadCompleted]);

  const prevMessagesLengthRef = useRef(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initialLoadCompleted && scrollContainerRef.current && messages.length > 0) {
      const wasNewMessageAdded = messages.length > prevMessagesLengthRef.current;
      prevMessagesLengthRef.current = messages.length;

      if (!wasNewMessageAdded) return;

      const scrollContainer = scrollContainerRef.current;
      const scrollTop = scrollContainer.scrollTop;
      const threshold = 100;
      const isNearBottom = scrollTop > -threshold;

      if (isNearBottom) {
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current);
        }
        scrollTimeoutRef.current = setTimeout(() => {
          if (hasActiveSelection()) return;
          if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTo({ top: 0, behavior: 'auto' });
          }
        }, 100);
      }
    }
    
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [initialLoadCompleted, messages.length, hasActiveSelection]);

  const optimisticMessages: UnifiedMessage[] = useMemo(() => {
    if (!showOptimisticUI || !optimisticPrompt) return [];
    
    return [{
      message_id: 'optimistic-user',
      thread_id: threadId,
      type: 'user' as const,
      is_llm_message: true,
      content: optimisticPrompt,
      metadata: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }];
  }, [showOptimisticUI, optimisticPrompt, threadId]);

  const displayMessages = showOptimisticUI ? optimisticMessages : messages;
  const displayAgentStatus = showOptimisticUI ? 'running' : agentStatus;
  const displayStreamHookStatus = showOptimisticUI ? 'connecting' : streamHookStatus;
  const displayStreamingText = showOptimisticUI ? '' : streamingTextContent;
  const displayProjectName = showOptimisticUI ? 'New Conversation' : projectName;
  
  if (!hasDataLoaded.current && !showOptimisticUI && (!initialLoadCompleted || isLoading || isThreadInitializing)) {
    return <ThreadSkeleton isSidePanelOpen={isSidePanelOpen} compact={compact} initializingMessage={
      isThreadInitializing ? 'Setting up your conversation...' : undefined
    } />;
  }

  if (threadInitializationError) {
    return (
      <ThreadLayout
        threadId={threadId}
        projectName={projectName}
        projectId={project?.id || ''}
        project={project}
        sandboxId={sandboxId}
        isSidePanelOpen={false}
        onToggleSidePanel={() => {}}
        onProjectRenamed={() => {}}
        onViewFiles={() => {}}
        toolCalls={[]}
        messages={[]}
        externalNavIndex={0}
        agentStatus="idle"
        currentToolIndex={0}
        onSidePanelNavigate={() => {}}
        onSidePanelClose={() => {}}
        renderAssistantMessage={() => <></>}
        renderToolResult={() => <></>}
        isLoading={false}
        isMobile={isMobile}
        initialLoadCompleted={true}
        variant={isShared ? 'shared' : 'default'}
        leftSidebarState={leftSidebarState}
      >
        <ThreadError 
          error={threadInitializationError || "Thread initialization failed"}
        />
      </ThreadLayout>
    );
  }

  if (error) {
    return (
      <ThreadLayout
        threadId={threadId}
        projectName={projectName}
        projectId={project?.id || ''}
        project={project}
        sandboxId={sandboxId}
        isSidePanelOpen={isSidePanelOpen}
        onToggleSidePanel={toggleSidePanel}
        onViewFiles={handleOpenFileViewer}
        toolCalls={toolCalls}
        messages={messages as ApiMessageType[]}
        externalNavIndex={externalNavIndex}
        agentStatus={agentStatus}
        currentToolIndex={currentToolIndex}
        onSidePanelNavigate={handleSidePanelNavigate}
        onSidePanelClose={handleSidePanelClose}
        renderAssistantMessage={toolViewAssistant}
        renderToolResult={toolViewResult}
        isLoading={!initialLoadCompleted || isLoading}
        isMobile={isMobile}
        initialLoadCompleted={initialLoadCompleted}
        agentName={derivedAgentInfo.agentName}
      >
        <ThreadError error={error} />
      </ThreadLayout>
    );
  }

  if (compact) {
    return (
      <>
        <ThreadLayout
          threadId={threadId}
          projectName={displayProjectName}
          projectId={project?.id || projectId}
          project={showOptimisticUI ? null : project}
          sandboxId={showOptimisticUI ? null : sandboxId}
          isSidePanelOpen={effectivePanelOpen}
          onToggleSidePanel={showOptimisticUI ? () => {} : toggleSidePanel}
          onProjectRenamed={handleProjectRenamed}
          onViewFiles={showOptimisticUI ? () => {} : handleOpenFileViewer}
          toolCalls={showOptimisticUI ? [] : toolCalls}
          messages={displayMessages as ApiMessageType[]}
          externalNavIndex={showOptimisticUI ? 0 : externalNavIndex}
          agentStatus={displayAgentStatus}
          currentToolIndex={showOptimisticUI ? 0 : currentToolIndex}
          onSidePanelNavigate={showOptimisticUI ? () => {} : handleSidePanelNavigate}
          onSidePanelClose={showOptimisticUI ? () => {} : handleSidePanelClose}
          renderAssistantMessage={toolViewAssistant}
          renderToolResult={toolViewResult}
          isLoading={showOptimisticUI ? false : (!initialLoadCompleted || isLoading)}
          isMobile={isMobile}
          initialLoadCompleted={showOptimisticUI ? true : initialLoadCompleted}
          agentName={derivedAgentInfo.agentName}
          disableInitialAnimation={showOptimisticUI || isNewThread || (!initialLoadCompleted && toolCalls.length > 0)}
          compact={true}
          streamingTextContent={isShared ? '' : displayStreamingText}
          streamingToolCall={isShared || showOptimisticUI ? undefined : streamingToolCall}
        >
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col-reverse"
          >
            <div className="flex-shrink-0">
              <ThreadContent
                messages={isShared ? playback.playbackState.visibleMessages : displayMessages}
                streamingTextContent={isShared ? '' : displayStreamingText}
                streamingToolCall={isShared ? playback.playbackState.currentToolCall : (showOptimisticUI ? undefined : streamingToolCall)}
                agentStatus={displayAgentStatus}
                handleToolClick={showOptimisticUI ? () => {} : handleToolClick}
                handleOpenFileViewer={showOptimisticUI ? () => {} : handleOpenFileViewer}
                readOnly={isShared}
                visibleMessages={isShared ? playback.playbackState.visibleMessages : undefined}
                streamingText={isShared ? playback.playbackState.streamingText : ''}
                isStreamingText={isShared ? playback.playbackState.isStreamingText : false}
                currentToolCall={isShared ? playback.playbackState.currentToolCall : undefined}
                streamHookStatus={displayStreamHookStatus}
                sandboxId={showOptimisticUI ? null : sandboxId}
                project={showOptimisticUI ? null : project}
                agentName={derivedAgentInfo.agentName}
                agentAvatar={undefined}
                scrollContainerRef={scrollContainerRef}
                isPreviewMode={true}
                onPromptFill={!isShared ? handlePromptFill : undefined}
                threadId={threadId}
              />
            </div>
          </div>

          {!isShared && (
            <div className="flex-shrink-0 border-t border-border/20 p-4">
              <ChatInput
                ref={chatInputRef}
                onSubmit={showOptimisticUI ? () => {} : handleSubmitMessage}
                placeholder={t('describeWhatYouNeed')}
                loading={showOptimisticUI ? false : isSending}
                disabled={showOptimisticUI || isSending}
                isAgentRunning={
                  displayAgentStatus === 'running' || displayAgentStatus === 'connecting'
                }
                onStopAgent={handleStopAgent}
                autoFocus={!isLoading && !showOptimisticUI}
                enableAdvancedConfig={false}
                onFileBrowse={handleOpenFileViewer}
                sandboxId={showOptimisticUI ? undefined : (sandboxId || undefined)}
                projectId={projectId}
                messages={displayMessages}
                agentName={derivedAgentInfo.agentName}
                selectedAgentId={selectedAgentId}
                onAgentSelect={handleAgentSelect}
                hideAgentSelection={!!configuredAgentId}
                toolCalls={showOptimisticUI ? [] : toolCalls}
                toolCallIndex={showOptimisticUI ? 0 : currentToolIndex}
                showToolPreview={!showOptimisticUI && !isSidePanelOpen && toolCalls.length > 0}
                onExpandToolPreview={handleExpandToolPreview}
                defaultShowSnackbar="tokens"
                showScrollToBottomIndicator={showScrollToBottom}
                onScrollToBottom={scrollToBottom}
                threadId={threadId}
              />
            </div>
          )}
          {isShared && (
            <PlaybackFloatingControls
              messageCount={messages.length}
              currentMessageIndex={playback.playbackState.currentMessageIndex}
              isPlaying={playback.playbackState.isPlaying}
              isSidePanelOpen={isSidePanelOpen}
              onTogglePlayback={playback.togglePlayback}
              onReset={playback.resetPlayback}
              onSkipToEnd={playback.skipToEnd}
              onForwardOne={playback.forwardOne}
              onBackwardOne={playback.backwardOne}
            />
          )}
        </ThreadLayout>

        <PlanSelectionModal
          open={showBillingModal}
          onOpenChange={closeBillingModal}
          creditsExhausted={creditsExhausted}
        />

      {agentLimitData && (
        <AgentRunLimitBanner
          open={showAgentLimitBanner}
          onOpenChange={(open) => {
            setShowAgentLimitBanner(open);
            if (!open) {
              setAgentLimitData(null);
            }
          }}
          runningCount={agentLimitData.runningCount}
          runningThreadIds={agentLimitData.runningThreadIds}
        />
      )}
      </>
    );
  }

  const chatInputElement = !isShared ? (
    <div className={cn('mx-auto', isMobile ? 'w-full' : 'max-w-3xl')}>
      <ChatInput
        ref={chatInputRef}
        onSubmit={showOptimisticUI ? () => {} : handleSubmitMessage}
        placeholder={t('describeWhatYouNeed')}
        loading={showOptimisticUI ? false : isSending}
        disabled={showOptimisticUI || isSending}
        isAgentRunning={
          displayAgentStatus === 'running' || displayAgentStatus === 'connecting'
        }
        onStopAgent={handleStopAgent}
        autoFocus={!isLoading && !showOptimisticUI}
        enableAdvancedConfig={false}
        onFileBrowse={handleOpenFileViewer}
        sandboxId={showOptimisticUI ? undefined : (sandboxId || undefined)}
        projectId={projectId}
        messages={displayMessages}
        agentName={derivedAgentInfo.agentName}
        selectedAgentId={selectedAgentId}
        onAgentSelect={handleAgentSelect}
        threadId={threadId}
        hideAgentSelection={!!configuredAgentId}
        toolCalls={showOptimisticUI ? [] : toolCalls}
        toolCallIndex={showOptimisticUI ? 0 : currentToolIndex}
        showToolPreview={!showOptimisticUI && !effectivePanelOpen && toolCalls.length > 0}
        onExpandToolPreview={handleExpandToolPreview}
        defaultShowSnackbar="tokens"
        showScrollToBottomIndicator={showScrollToBottom}
        onScrollToBottom={scrollToBottom}
        bgColor="bg-card"
      />
    </div>
  ) : undefined;

  return (
    <>
      <ThreadLayout
        threadId={threadId}
        projectName={displayProjectName}
        projectId={project?.id || projectId}
        project={showOptimisticUI ? null : project}
        sandboxId={showOptimisticUI ? null : sandboxId}
        isSidePanelOpen={effectivePanelOpen}
        onToggleSidePanel={showOptimisticUI ? () => {} : toggleSidePanel}
        onProjectRenamed={handleProjectRenamed}
        onViewFiles={showOptimisticUI ? () => {} : handleOpenFileViewer}
        toolCalls={showOptimisticUI ? [] : toolCalls}
        messages={displayMessages as ApiMessageType[]}
        externalNavIndex={showOptimisticUI ? 0 : externalNavIndex}
        agentStatus={displayAgentStatus}
        currentToolIndex={showOptimisticUI ? 0 : currentToolIndex}
        onSidePanelNavigate={showOptimisticUI ? () => {} : handleSidePanelNavigate}
        onSidePanelClose={showOptimisticUI ? () => {} : handleSidePanelClose}
        renderAssistantMessage={toolViewAssistant}
        renderToolResult={toolViewResult}
        isLoading={showOptimisticUI ? false : (!initialLoadCompleted || isLoading)}
        isMobile={isMobile}
        initialLoadCompleted={showOptimisticUI ? true : initialLoadCompleted}
        agentName={derivedAgentInfo.agentName}
        disableInitialAnimation={showOptimisticUI || isNewThread || (!initialLoadCompleted && toolCalls.length > 0)}
        variant={isShared ? 'shared' : 'default'}
        chatInput={chatInputElement}
        leftSidebarState={leftSidebarState}
        streamingTextContent={isShared ? '' : displayStreamingText}
        streamingToolCall={isShared || showOptimisticUI ? undefined : streamingToolCall}
      >
        <ThreadContent
          messages={isShared ? playback.playbackState.visibleMessages : displayMessages}
          streamingTextContent={isShared ? '' : displayStreamingText}
          streamingToolCall={isShared ? playback.playbackState.currentToolCall : (showOptimisticUI ? undefined : streamingToolCall)}
          agentStatus={displayAgentStatus}
          handleToolClick={showOptimisticUI ? () => {} : handleToolClick}
          handleOpenFileViewer={showOptimisticUI ? () => {} : handleOpenFileViewer}
          readOnly={isShared}
          visibleMessages={isShared ? playback.playbackState.visibleMessages : undefined}
          streamingText={isShared ? playback.playbackState.streamingText : ''}
          isStreamingText={isShared ? playback.playbackState.isStreamingText : false}
          currentToolCall={isShared ? playback.playbackState.currentToolCall : undefined}
          streamHookStatus={displayStreamHookStatus}
          sandboxId={showOptimisticUI ? null : sandboxId}
          project={showOptimisticUI ? null : project}
          agentName={derivedAgentInfo.agentName}
          agentAvatar={undefined}
          scrollContainerRef={scrollContainerRef}
          threadId={threadId}
          onPromptFill={!isShared ? handlePromptFill : undefined}
        />

        {isShared && (
          <PlaybackFloatingControls
            messageCount={displayMessages.length}
            currentMessageIndex={playback.playbackState.currentMessageIndex}
            isPlaying={playback.playbackState.isPlaying}
            isSidePanelOpen={isSidePanelOpen}
            onTogglePlayback={playback.togglePlayback}
            onReset={playback.resetPlayback}
            onSkipToEnd={playback.skipToEnd}
            onForwardOne={playback.forwardOne}
            onBackwardOne={playback.backwardOne}
          />
        )}
      </ThreadLayout>

      <PlanSelectionModal
        open={showBillingModal}
        onOpenChange={closeBillingModal}
        creditsExhausted={creditsExhausted}
      />

      {agentLimitData && (
        <AgentRunLimitBanner
          open={showAgentLimitBanner}
          onOpenChange={(open) => {
            setShowAgentLimitBanner(open);
            if (!open) {
              setAgentLimitData(null);
            }
          }}
          runningCount={agentLimitData.runningCount}
          runningThreadIds={agentLimitData.runningThreadIds}
        />
      )}
    </>
  );
}

