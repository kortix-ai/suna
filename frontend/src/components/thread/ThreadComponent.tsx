'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { AgentRunLimitError, ProjectLimitError, BillingError } from '@/lib/api/errors';
import { toast } from 'sonner';
import { ChatInput } from '@/components/thread/chat-input/chat-input';
import { useSidebar, SidebarContext } from '@/components/ui/sidebar';
import { useAgentStream } from '@/hooks/agents';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/utils';
import { isLocalMode } from '@/lib/config';
import { ThreadContent } from '@/components/thread/content/ThreadContent';
import { ThreadSkeleton } from '@/components/thread/content/ThreadSkeleton';
import { PlaybackFloatingControls } from '@/components/thread/content/PlaybackFloatingControls';
import { usePlaybackController } from '@/hooks/usePlaybackController';
import { useAddUserMessageMutation } from '@/hooks/threads/use-messages';
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
  useThreadToolCalls,
  useThreadBilling,
  useThreadKeyboardShortcuts,
} from '@/hooks/threads/page';
import { ThreadError, ThreadLayout } from '@/components/thread/layout';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { useBillingModal } from '@/hooks/billing/use-billing-modal';

import {
  useThreadAgent,
  useAgents,
} from '@/hooks/agents/use-agents';
import { AgentRunLimitDialog } from '@/components/thread/agent-run-limit-dialog';
import { useAgentSelection } from '@/stores/agent-selection-store';
import { useQueryClient } from '@tanstack/react-query';
import { threadKeys } from '@/hooks/threads/keys';
import { fileQueryKeys } from '@/hooks/files';
import { useProjectRealtime } from '@/hooks/threads';
import { handleGoogleSlidesUpload } from './tool-views/utils/presentation-utils';
import { useTranslations } from 'next-intl';

interface ThreadComponentProps {
  projectId: string;
  threadId: string;
  compact?: boolean;
  configuredAgentId?: string; // When set, only allow selection of this specific agent
  isShared?: boolean; // When true, enables read-only share mode with playback controls
}

export function ThreadComponent({ projectId, threadId, compact = false, configuredAgentId, isShared = false }: ThreadComponentProps) {
  const t = useTranslations('dashboard');
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // Check if user is authenticated
  const { user } = useAuth();
  const isAuthenticated = !!user;

  // State
  const [isSending, setIsSending] = useState(false);
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [fileToView, setFileToView] = useState<string | null>(null);
  const [filePathList, setFilePathList] = useState<string[] | undefined>(
    undefined,
  );
  const [chatInputValue, setChatInputValue] = useState('');
  const [initialPanelOpenAttempted, setInitialPanelOpenAttempted] =
    useState(false);
  // Use Zustand store for agent selection persistence - skip in shared mode
  // Always call hooks unconditionally, but disable queries for unauthenticated users
  const agentSelection = useAgentSelection();
  const agentsQuery = useAgents({}, { enabled: isAuthenticated && !isShared });

  // Use conditional values based on isShared
  const {
    selectedAgentId,
    setSelectedAgent,
    initializeFromAgents,
    getCurrentAgent,
    isSunaAgent,
  } = isShared ? {
    selectedAgentId: undefined,
    setSelectedAgent: () => { },
    initializeFromAgents: () => { },
    getCurrentAgent: () => undefined,
    isSunaAgent: false,
  } : agentSelection;

  const agents = isShared ? [] : (agentsQuery?.data?.agents || []);
  const [isSidePanelAnimating, setIsSidePanelAnimating] = useState(false);
  const [userInitiatedRun, setUserInitiatedRun] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
  const [agentLimitData, setAgentLimitData] = useState<{
    runningCount: number;
    runningThreadIds: string[];
  } | null>(null);

  // Refs - simplified for flex-column-reverse
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const initialLayoutAppliedRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastStreamStartedRef = useRef<string | null>(null); // Track last runId we started streaming for
  const pendingMessageRef = useRef<string | null>(null); // Store pending message to add when agent starts

  // Sidebar - safely use it if SidebarProvider is available (logged in users on share page will have it)
  // Use React.useContext directly which returns null if context is not available (doesn't throw)
  const sidebarContext = React.useContext(SidebarContext);
  const leftSidebarState: 'expanded' | 'collapsed' | undefined = sidebarContext?.state;
  const setLeftSidebarOpen: ((open: boolean) => void) | undefined = sidebarContext?.setOpen;

  // Custom hooks
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
  } = useThreadData(threadId, projectId, isShared);

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

  // Billing hooks - always call unconditionally, but disable for unauthenticated/shared
  const billingModal = useBillingModal();
  const threadBilling = useThreadBilling(
    null,
    agentStatus,
    initialLoadCompleted,
    () => {
      billingModal.openModal();
    },
    isAuthenticated && !isShared // Only enable for authenticated non-shared users
  );

  // Use conditional values based on isShared
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
    billingStatusQuery,
  } = isShared ? {
    checkBillingLimits: async () => false,
    billingStatusQuery: { data: undefined, isLoading: false, error: null, refetch: async () => { } } as any,
  } : threadBilling;

  // Real-time project updates (for sandbox creation) - always call unconditionally
  useProjectRealtime(projectId);

  // Keyboard shortcuts
  useThreadKeyboardShortcuts({
    isSidePanelOpen,
    setIsSidePanelOpen,
    leftSidebarState,
    setLeftSidebarOpen,
    userClosedPanelRef,
  });

  // Mutations - always call unconditionally
  const addUserMessageMutation = useAddUserMessageMutation();
  const startAgentMutation = useStartAgentMutation();
  const stopAgentMutation = useStopAgentMutation();
  const threadAgentQuery = useThreadAgent(threadId, { enabled: isAuthenticated && !isShared });

  // Use conditional values based on isShared
  const { data: threadAgentData } = isShared ? { data: undefined } : threadAgentQuery;
  const agent = threadAgentData?.agent;

  useEffect(() => {
    if (!isShared) {
      queryClient.invalidateQueries({ queryKey: threadKeys.agentRuns(threadId) });
      queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) });
    }
  }, [threadId, queryClient, isShared]);

  // Listen for sandbox-active event to invalidate file caches
  useEffect(() => {
    const handleSandboxActive = (event: Event) => {
      const customEvent = event as CustomEvent<{ sandboxId: string; projectId: string }>;
      const { sandboxId, projectId: eventProjectId } = customEvent.detail;

      // Only invalidate if it's for this project
      if (eventProjectId === projectId) {

        // Invalidate all file content queries
        queryClient.invalidateQueries({
          queryKey: fileQueryKeys.contents()
        });

        // This will cause all file attachments to refetch with the now-active sandbox
        // toast.success('Sandbox is ready');
      }
    };

    window.addEventListener('sandbox-active', handleSandboxActive);
    return () => window.removeEventListener('sandbox-active', handleSandboxActive);
  }, [projectId, queryClient]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);

    if (urlParams.get('google_auth') === 'success') {
      // Clean up the URL parameters first
      window.history.replaceState({}, '', window.location.pathname);

      // Check if there was an intent to upload to Google Slides
      const uploadIntent = sessionStorage.getItem('google_slides_upload_intent');
      if (uploadIntent) {
        sessionStorage.removeItem('google_slides_upload_intent');

        try {
          const uploadData = JSON.parse(uploadIntent);
          const { presentation_path, sandbox_url } = uploadData;

          if (presentation_path && sandbox_url) {
            // Handle upload in async function
            (async () => {
              const uploadPromise = handleGoogleSlidesUpload(
                sandbox_url,
                presentation_path
              );

              // Show loading toast and handle upload
              const loadingToast = toast.loading('Google authentication successful! Uploading presentation...');

              try {
                await uploadPromise;
                // Success toast is now handled universally by handleGoogleSlidesUpload
              } catch (error) {
                console.error('Upload failed:', error);
                // Error toast is also handled universally by handleGoogleSlidesUpload
              } finally {
                // Always dismiss loading toast
                toast.dismiss(loadingToast);
              }
            })();
          }
        } catch (error) {
          console.error('Error processing Google Slides upload from session:', error);
          // Error toast is handled universally by handleGoogleSlidesUpload, no need to duplicate
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

  useEffect(() => {
    if (agents.length > 0) {
      // If configuredAgentId is provided, use it as the forced selection
      // Otherwise, fall back to threadAgentId (existing behavior)
      const threadAgentId = threadAgentData?.agent?.agent_id;
      const agentIdToUse = configuredAgentId || threadAgentId;

      initializeFromAgents(agents, agentIdToUse);

      // If configuredAgentId is provided, force selection and override any existing selection
      if (configuredAgentId && selectedAgentId !== configuredAgentId) {
        setSelectedAgent(configuredAgentId);
      }
    }
  }, [threadAgentData, agents, initializeFromAgents, configuredAgentId, selectedAgentId, setSelectedAgent]);

  // Always call unconditionally
  const sharedSubscription = useSharedSubscription();
  const { data: subscriptionData } = isShared ? { data: undefined } : sharedSubscription;
  const subscriptionStatus: SubscriptionStatus =
    subscriptionData?.status === 'active' ||
      subscriptionData?.status === 'trialing'
      ? 'active'
      : 'no_subscription';

  const handleProjectRenamed = useCallback((newName: string) => { }, []);

  // Create restricted agent selection handler when configuredAgentId is provided
  const handleAgentSelect = useCallback((agentId: string | undefined) => {
    // If configuredAgentId is set, only allow selection of that specific agent
    if (configuredAgentId) {
      if (agentId === configuredAgentId) {
        setSelectedAgent(agentId);
      }
      // Ignore attempts to select other agents
      return;
    }

    // Normal agent selection behavior
    setSelectedAgent(agentId);
  }, [configuredAgentId, setSelectedAgent]);

  // scrollToBottom for flex-column-reverse layout
  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  const handleNewMessageFromStream = useCallback(
    (message: UnifiedMessage) => {
      if (!message.message_id) {
        console.warn(
          `[STREAM HANDLER] Received message is missing ID: Type=${message.type}`,
        );
      }

      setMessages((prev) => {
        const messageExists = prev.some(
          (m) => m.message_id === message.message_id,
        );
        if (messageExists) {
          return prev.map((m) =>
            m.message_id === message.message_id ? message : m,
          );
        } else {
          // If this is a user message, replace any optimistic user message with temp ID
          if (message.type === 'user') {
            const optimisticIndex = prev.findIndex(
              (m) =>
                m.type === 'user' &&
                m.message_id?.startsWith('temp-') &&
                m.content === message.content,
            );
            if (optimisticIndex !== -1) {
              // Replace the optimistic message with the real one
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

      // Auto-scroll to bottom (top: 0 in flex-col-reverse) when new messages arrive
      setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }, 100);
    },
    [setMessages, setAutoOpenedPanel],
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

          // No scroll needed with flex-column-reverse
          break;
        case 'connecting':
          setAgentStatus('connecting');

          // Add optimistic message when agent starts connecting
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
            pendingMessageRef.current = null; // Clear after adding

            // Auto-scroll to bottom when message is added
            setTimeout(() => {
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
    [setAgentStatus, setAgentRunId, setAutoOpenedPanel, threadId, setMessages],
  );

  const handleStreamError = useCallback((errorMessage: string) => {
    const lower = errorMessage.toLowerCase();
    const isExpected =
      lower.includes('not found') || lower.includes('agent run is not running');

    // Check if this is a billing error
    const isBillingError =
      lower.includes('insufficient credits') ||
      lower.includes('credit') ||
      lower.includes('balance') ||
      lower.includes('out of credits') ||
      lower.includes('no credits');

    if (isBillingError) {
      console.error(`[PAGE] Agent stopped due to billing error: ${errorMessage}`);
      // Create a BillingError to pass to the modal
      const billingError = new BillingError(402, {
        message: errorMessage,
      });
      openBillingModal(billingError);
      pendingMessageRef.current = null;
      return;
    }

    // Downgrade log level for expected/benign cases (opening old conversations)
    if (isExpected) {
      return;
    }

    console.error(`[PAGE] Stream hook error: ${errorMessage}`);
    toast.error(`Stream Error: ${errorMessage}`);

    // Clear pending message on error
    pendingMessageRef.current = null;
  }, [openBillingModal]);

  const handleStreamClose = useCallback(() => { }, []);

  const {
    status: streamHookStatus,
    textContent: streamingTextContent,
    toolCall: streamingToolCall,
    error: streamError,
    agentRunId: currentHookRunId,
    startStreaming,
    stopStreaming,
  } = useAgentStream(
    {
      onMessage: handleNewMessageFromStream,
      onStatusChange: handleStreamStatusChange,
      onError: handleStreamError,
      onClose: handleStreamClose,
    },
    threadId,
    setMessages,
    threadAgentData?.agent?.agent_id,
  );

  const handleSubmitMessage = useCallback(
    async (
      message: string,
      options?: { model_name?: string },
    ) => {
      if (!message.trim() || isShared || !addUserMessageMutation || !startAgentMutation) return;
      setIsSending(true);

      // Clear the chat input value
      setChatInputValue('');

      // Store the message to add optimistically when agent starts running
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
            setShowAgentLimitDialog(true);
            return;
          }

          if (error instanceof ProjectLimitError) {
            openBillingModal(error);
            return;
          }

          throw new Error(`Failed to start agent: ${error?.message || error}`);
        }

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
      setChatInputValue,
    ],
  );

  const handleStopAgent = useCallback(async () => {
    if (isShared) return; // Cannot stop agent in shared mode

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
      if (filePath) {
        setFileToView(filePath);
      } else {
        setFileToView(null);
      }
      setFilePathList(filePathList);
      setFileViewerOpen(true);
    },
    [],
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

  // Playback controller for shared mode - using proper custom hook
  const playback = usePlaybackController({
    messages,
    enabled: isShared,
    isSidePanelOpen,
    onToggleSidePanel: toggleSidePanel,
    setCurrentToolIndex,
    toolCalls,
  });

  // Effects
  useEffect(() => {
    if (!initialLayoutAppliedRef.current) {
      setLeftSidebarOpen?.(false);
      initialLayoutAppliedRef.current = true;
    }
  }, [setLeftSidebarOpen]);

  useEffect(() => {
    if (initialLoadCompleted && !initialPanelOpenAttempted) {
      setInitialPanelOpenAttempted(true);

      // Only auto-open on desktop, not mobile, and not in compact mode
      if (!isMobile && !compact) {
        if (toolCalls.length > 0) {
          setIsSidePanelOpen(true);
          setCurrentToolIndex(toolCalls.length - 1);
        } else {
          if (messages.length > 0) {
            setIsSidePanelOpen(true);
          }
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
  ]);

  useEffect(() => {
    // Prevent duplicate streaming calls for the same runId
    if (agentRunId && lastStreamStartedRef.current === agentRunId) {
      return;
    }

    // Start streaming if user initiated a run (don't wait for initialLoadCompleted for first-time users)
    if (agentRunId && agentRunId !== currentHookRunId && userInitiatedRun) {
      startStreaming(agentRunId);
      lastStreamStartedRef.current = agentRunId; // Track that we started this runId
      setUserInitiatedRun(false); // Reset flag after starting
      return;
    }

    // Only auto-start streaming on page load if we know the agent is currently running
    if (
      agentRunId &&
      agentRunId !== currentHookRunId &&
      initialLoadCompleted &&
      !userInitiatedRun &&
      agentStatus === 'running'
    ) {
      startStreaming(agentRunId);
      lastStreamStartedRef.current = agentRunId; // Track that we started this runId
    }
  }, [
    agentRunId,
    startStreaming,
    currentHookRunId,
    initialLoadCompleted,
    userInitiatedRun,
    agentStatus,
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
      // Reset the stream tracking ref when stream completes
      lastStreamStartedRef.current = null;
    }
  }, [streamHookStatus, agentStatus, setAgentStatus, setAgentRunId]);

  // Reset stream tracking ref when threadId changes  
  useEffect(() => {
    lastStreamStartedRef.current = null;
  }, [threadId]);

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
          `${projectName} - Interactive agent conversation powered by Kortix`,
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
        openBillingModal(); // Open without error for free tier prompt
      }
    }
  }, [subscriptionData, subscriptionStatus, initialLoadCompleted, openBillingModal]);


  useEffect(() => {
    if (streamingToolCall) {
      handleStreamingToolCall(streamingToolCall);
    }
  }, [streamingToolCall, handleStreamingToolCall]);

  useEffect(() => {
    setIsSidePanelAnimating(true);
    const timer = setTimeout(() => setIsSidePanelAnimating(false), 200); // Match transition duration
    return () => clearTimeout(timer);
  }, [isSidePanelOpen]);

  // Scroll detection for show/hide scroll-to-bottom button
  useEffect(() => {
    if (!initialLoadCompleted) return;

    const checkScrollPosition = () => {
      if (!scrollContainerRef.current) {
        setShowScrollToBottom(false);
        return;
      }

      const scrollTop = scrollContainerRef.current.scrollTop;
      const scrollHeight = scrollContainerRef.current.scrollHeight;
      const clientHeight = scrollContainerRef.current.clientHeight;
      const threshold = 50;

      // With flex-column-reverse, scrollTop can be NEGATIVE:
      // - scrollTop = 0 or negative means we're at the "top" (visually the bottom/newest messages)
      // - scrollTop becomes more negative as we scroll up (visually) from the bottom
      // - scrollTop = -(scrollHeight - clientHeight) when fully scrolled up
      // Show button when scrolled up enough from bottom (scrollTop is negative and less than -threshold)
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

    // Attach scroll listener
    scrollContainer.addEventListener('scroll', checkScrollPosition, {
      passive: true,
    });

    // Also use ResizeObserver to check when content size changes
    const resizeObserver = new ResizeObserver(() => {
      checkScrollPosition();
    });
    resizeObserver.observe(scrollContainer);

    // Check initial state with multiple timeouts to catch layout changes
    const timeout1 = setTimeout(checkScrollPosition, 100);
    const timeout2 = setTimeout(checkScrollPosition, 300);
    const timeout3 = setTimeout(checkScrollPosition, 500);
    const timeout4 = setTimeout(checkScrollPosition, 1000);

    return () => {
      scrollContainer.removeEventListener('scroll', checkScrollPosition);
      resizeObserver.disconnect();
      clearTimeout(timeout1);
      clearTimeout(timeout2);
      clearTimeout(timeout3);
      clearTimeout(timeout4);
    };
  }, [messages, initialLoadCompleted]);

  // Auto-scroll to bottom on initial load
  useEffect(() => {
    if (initialLoadCompleted && scrollContainerRef.current && messages.length > 0) {
      // Small delay to ensure DOM is fully rendered
      const timeoutId = setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: 0, behavior: 'auto' });
        }
      }, 200);
      return () => clearTimeout(timeoutId);
    }
  }, [initialLoadCompleted, messages.length]);

  if (!initialLoadCompleted || isLoading) {
    return <ThreadSkeleton isSidePanelOpen={isSidePanelOpen} compact={compact} />;
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
        fileViewerOpen={fileViewerOpen}
        setFileViewerOpen={setFileViewerOpen}
        fileToView={fileToView}
        filePathList={filePathList}
        toolCalls={toolCalls}
        messages={messages as ApiMessageType[]}
        externalNavIndex={externalNavIndex}
        agentStatus={agentStatus}
        currentToolIndex={currentToolIndex}
        onSidePanelNavigate={handleSidePanelNavigate}
        onSidePanelClose={() => {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
          setAutoOpenedPanel(true);
        }}
        renderAssistantMessage={toolViewAssistant}
        renderToolResult={toolViewResult}
        isLoading={!initialLoadCompleted || isLoading}
        isMobile={isMobile}
        initialLoadCompleted={initialLoadCompleted}
        agentName={agent && agent.name}
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
          projectName={projectName}
          projectId={project?.id || ''}
          project={project}
          sandboxId={sandboxId}
          isSidePanelOpen={isSidePanelOpen}
          onToggleSidePanel={toggleSidePanel}
          onProjectRenamed={handleProjectRenamed}
          onViewFiles={handleOpenFileViewer}
          fileViewerOpen={fileViewerOpen}
          setFileViewerOpen={setFileViewerOpen}
          fileToView={fileToView}
          filePathList={filePathList}
          toolCalls={toolCalls}
          messages={messages as ApiMessageType[]}
          externalNavIndex={externalNavIndex}
          agentStatus={agentStatus}
          currentToolIndex={currentToolIndex}
          onSidePanelNavigate={handleSidePanelNavigate}
          onSidePanelClose={() => {
            setIsSidePanelOpen(false);
            userClosedPanelRef.current = true;
            setAutoOpenedPanel(true);
          }}
          renderAssistantMessage={toolViewAssistant}
          renderToolResult={toolViewResult}
          isLoading={!initialLoadCompleted || isLoading}
          isMobile={isMobile}
          initialLoadCompleted={initialLoadCompleted}
          agentName={agent && agent.name}
          disableInitialAnimation={!initialLoadCompleted && toolCalls.length > 0}
          compact={true}
        >
          {/* Thread Content - Scrollable */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col-reverse"
          >
            <div className="flex-shrink-0">
              <ThreadContent
                messages={isShared ? playback.playbackState.visibleMessages : messages}
                streamingTextContent={isShared ? '' : streamingTextContent}
                streamingToolCall={isShared ? playback.playbackState.currentToolCall : streamingToolCall}
                agentStatus={agentStatus}
                handleToolClick={handleToolClick}
                handleOpenFileViewer={handleOpenFileViewer}
                readOnly={isShared}
                visibleMessages={isShared ? playback.playbackState.visibleMessages : undefined}
                streamingText={isShared ? playback.playbackState.streamingText : ''}
                isStreamingText={isShared ? playback.playbackState.isStreamingText : false}
                currentToolCall={isShared ? playback.playbackState.currentToolCall : undefined}
                streamHookStatus={streamHookStatus}
                sandboxId={sandboxId}
                project={project}
                agentName={agent && agent.name}
                agentAvatar={undefined}
                scrollContainerRef={scrollContainerRef}
                isPreviewMode={true}
                onPromptFill={!isShared ? setChatInputValue : undefined}
                threadId={threadId}
              />
            </div>
          </div>

          {/* Compact Chat Input or Playback Controls */}
          {!isShared && (
            <div className="flex-shrink-0 border-t border-border/20  p-4">
              <ChatInput
                onSubmit={handleSubmitMessage}
                placeholder={t('describeWhatYouNeed')}
                loading={isSending}
                disabled={isSending}
                isAgentRunning={
                  agentStatus === 'running' || agentStatus === 'connecting'
                }
                onStopAgent={handleStopAgent}
                autoFocus={!isLoading}
                enableAdvancedConfig={false}
                onFileBrowse={handleOpenFileViewer}
                sandboxId={sandboxId || undefined}
                projectId={projectId}
                messages={messages}
                agentName={agent && agent.name}
                selectedAgentId={selectedAgentId}
                onAgentSelect={handleAgentSelect}
                hideAgentSelection={!!configuredAgentId}
                toolCalls={toolCalls}
                toolCallIndex={currentToolIndex}
                showToolPreview={!isSidePanelOpen && toolCalls.length > 0}
                onExpandToolPreview={() => {
                  setIsSidePanelOpen(true);
                  userClosedPanelRef.current = false;
                }}
                defaultShowSnackbar="tokens"
                showScrollToBottomIndicator={showScrollToBottom}
                onScrollToBottom={scrollToBottom}
                threadId={threadId}
                value={chatInputValue}
                onChange={setChatInputValue}
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
          <AgentRunLimitDialog
            open={showAgentLimitDialog}
            onOpenChange={setShowAgentLimitDialog}
            runningCount={agentLimitData.runningCount}
            runningThreadIds={agentLimitData.runningThreadIds}
            projectId={projectId}
          />
        )}
      </>
    );
  }

  // Full layout version for dedicated thread pages
  // Prepare ChatInput component
  const chatInputElement = !isShared ? (
    <div className={cn('mx-auto', isMobile ? 'w-full' : 'max-w-3xl')}>
      <ChatInput
        onSubmit={handleSubmitMessage}
        placeholder={t('describeWhatYouNeed')}
        loading={isSending}
        disabled={isSending}
        isAgentRunning={
          agentStatus === 'running' || agentStatus === 'connecting'
        }
        onStopAgent={handleStopAgent}
        autoFocus={!isLoading}
        enableAdvancedConfig={false}
        onFileBrowse={handleOpenFileViewer}
        sandboxId={sandboxId || undefined}
        projectId={projectId}
        messages={messages}
        agentName={agent && agent.name}
        selectedAgentId={selectedAgentId}
        onAgentSelect={handleAgentSelect}
        threadId={threadId}
        hideAgentSelection={!!configuredAgentId}
        toolCalls={toolCalls}
        toolCallIndex={currentToolIndex}
        showToolPreview={!isSidePanelOpen && toolCalls.length > 0}
        onExpandToolPreview={() => {
          setIsSidePanelOpen(true);
          userClosedPanelRef.current = false;
        }}
        defaultShowSnackbar="tokens"
        showScrollToBottomIndicator={showScrollToBottom}
        onScrollToBottom={scrollToBottom}
        bgColor="bg-card"
        value={chatInputValue}
        onChange={setChatInputValue}
      />
    </div>
  ) : undefined;

  return (
    <>
      <ThreadLayout
        threadId={threadId}
        projectName={projectName}
        projectId={project?.id || ''}
        project={project}
        sandboxId={sandboxId}
        isSidePanelOpen={isSidePanelOpen}
        onToggleSidePanel={toggleSidePanel}
        onProjectRenamed={handleProjectRenamed}
        onViewFiles={handleOpenFileViewer}
        fileViewerOpen={fileViewerOpen}
        setFileViewerOpen={setFileViewerOpen}
        fileToView={fileToView}
        filePathList={filePathList}
        toolCalls={toolCalls}
        messages={messages as ApiMessageType[]}
        externalNavIndex={externalNavIndex}
        agentStatus={agentStatus}
        currentToolIndex={currentToolIndex}
        onSidePanelNavigate={handleSidePanelNavigate}
        onSidePanelClose={() => {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
          setAutoOpenedPanel(true);
        }}
        renderAssistantMessage={toolViewAssistant}
        renderToolResult={toolViewResult}
        isLoading={!initialLoadCompleted || isLoading}
        isMobile={isMobile}
        initialLoadCompleted={initialLoadCompleted}
        agentName={agent && agent.name}
        disableInitialAnimation={!initialLoadCompleted && toolCalls.length > 0}
        variant={isShared ? 'shared' : 'default'}
        chatInput={chatInputElement}
        leftSidebarState={leftSidebarState}
      >
        <ThreadContent
          messages={isShared ? playback.playbackState.visibleMessages : messages}
          streamingTextContent={isShared ? '' : streamingTextContent}
          streamingToolCall={isShared ? playback.playbackState.currentToolCall : streamingToolCall}
          agentStatus={agentStatus}
          handleToolClick={handleToolClick}
          handleOpenFileViewer={handleOpenFileViewer}
          readOnly={isShared}
          visibleMessages={isShared ? playback.playbackState.visibleMessages : undefined}
          streamingText={isShared ? playback.playbackState.streamingText : ''}
          isStreamingText={isShared ? playback.playbackState.isStreamingText : false}
          currentToolCall={isShared ? playback.playbackState.currentToolCall : undefined}
          streamHookStatus={streamHookStatus}
          sandboxId={sandboxId}
          project={project}
          agentName={agent && agent.name}
          agentAvatar={undefined}
          scrollContainerRef={scrollContainerRef}
          threadId={threadId}
          onPromptFill={!isShared ? setChatInputValue : undefined}
        />

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
        <AgentRunLimitDialog
          open={showAgentLimitDialog}
          onOpenChange={setShowAgentLimitDialog}
          runningCount={agentLimitData.runningCount}
          runningThreadIds={agentLimitData.runningThreadIds}
          projectId={projectId}
        />
      )}
    </>
  );
}
