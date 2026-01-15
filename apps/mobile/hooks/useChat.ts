import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Alert, Keyboard, AppState, AppStateStatus } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import type { UnifiedMessage } from '@/api/types';
import { useLanguage } from '@/contexts';
import type { ToolMessagePair } from '@/components/chat';
import {
  useThreads,
  useThread,
  useMessages,
  useSendMessage as useSendMessageMutation,
  useUnifiedAgentStart as useUnifiedAgentStartMutation,
  useStopAgentRun as useStopAgentRunMutation,
  useActiveAgentRuns,
  useUpdateThread,
  chatKeys,
} from '@/lib/chat';
import {
  useUploadMultipleFiles,
  convertAttachmentsToFormDataFiles,
  generateFileReferences,
  validateFileSize,
} from '@/lib/files';
import { transcribeAudio, validateAudioFile } from '@/lib/chat/transcription';
import { detectModeFromContent } from '@/lib/chat/modeDetection';
import { useAgentStream } from './useAgentStream';
import { useAgent } from '@/contexts/AgentContext';
import { useAvailableModels } from '@/lib/models';
import { useBillingContext } from '@/contexts/BillingContext';
import { log } from '@/lib/logger';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

export interface Attachment {
  type: 'image' | 'video' | 'document';
  uri: string;
  name?: string;
  size?: number;
  mimeType?: string;
  isUploading?: boolean;
  uploadProgress?: number;
  uploadError?: string;
}

// Per-mode state for instant tab-like switching
interface ModeState {
  threadId: string | undefined;
  messages: UnifiedMessage[];
  agentRunId: string | null;
  sandboxId: string | undefined;
  viewState: 'thread-list' | 'thread';
  inputValue: string;
  attachments: Attachment[];
  selectedOption: string | null;
}

export interface UseChatReturn {
  activeThread: {
    id: string;
    title?: string;
    messages: UnifiedMessage[];
    createdAt: Date;
    updatedAt: Date;
  } | null;
  threads: any[];
  loadThread: (threadId: string) => void;
  startNewChat: () => void;
  updateThreadTitle: (newTitle: string) => Promise<void>;
  hasActiveThread: boolean;
  refreshMessages: () => Promise<void>;
  activeSandboxId?: string;
  
  messages: UnifiedMessage[];
  streamingContent: string;
  streamingToolCall: UnifiedMessage | null;
  isStreaming: boolean;
  isReconnecting: boolean;
  retryCount: number;
  
  sendMessage: (content: string, agentId: string, agentName: string) => Promise<void>;
  stopAgent: () => void;
  
  inputValue: string;
  setInputValue: (value: string) => void;
  attachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (index: number) => void;
  
  selectedToolData: {
    toolMessages: ToolMessagePair[];
    initialIndex: number;
  } | null;
  setSelectedToolData: (data: { toolMessages: ToolMessagePair[]; initialIndex: number; } | null) => void;
  
  isLoading: boolean;
  isSendingMessage: boolean;
  isAgentRunning: boolean;
  isNewThreadOptimistic: boolean;

  // Error state for stream errors
  streamError: string | null;
  retryLastMessage: () => void;
  isRetrying: boolean;
  hasActiveRun: boolean;
  
  handleTakePicture: () => Promise<void>;
  handleChooseImages: () => Promise<void>;
  handleChooseFiles: () => Promise<void>;
  
  selectedQuickAction: string | null;
  selectedQuickActionOption: string | null;
  handleQuickAction: (actionId: string) => void;
  setSelectedQuickActionOption: (optionId: string | null) => void;
  clearQuickAction: () => void;
  getPlaceholder: () => string;
  
  // Mode view state
  modeViewState: 'thread-list' | 'thread';
  showModeThreadList: () => void;
  showModeThread: (threadId: string) => void;
  
  isAttachmentDrawerVisible: boolean;
  openAttachmentDrawer: () => void;
  closeAttachmentDrawer: () => void;
  
  transcribeAndAddToInput: (audioUri: string) => Promise<void>;
  isTranscribing: boolean;
}

export function useChat(): UseChatReturn {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { selectedModelId, selectedAgentId } = useAgent();
  const { data: modelsData, isLoading: modelsLoading, error: modelsError } = useAvailableModels();
  const { hasActiveSubscription } = useBillingContext();

  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selectedToolData, setSelectedToolData] = useState<{
    toolMessages: ToolMessagePair[];
    initialIndex: number;
  } | null>(null);
  const [isAttachmentDrawerVisible, setIsAttachmentDrawerVisible] = useState(false);
  const [selectedQuickAction, setSelectedQuickAction] = useState<string | null>('slides');
  const [selectedQuickActionOption, setSelectedQuickActionOption] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [modeViewState, setModeViewState] = useState<'thread-list' | 'thread'>('thread-list');
  const [isNewThreadOptimistic, setIsNewThreadOptimistic] = useState(false);
  const [activeSandboxId, setActiveSandboxId] = useState<string | undefined>(undefined);
  const [userInitiatedRun, setUserInitiatedRun] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  
  // Track last message params for retry functionality
  const lastMessageParamsRef = useRef<{
    content: string;
    agentId: string;
    agentName: string;
  } | null>(null);
  
  // Per-mode full state: keeps entire mode state in memory for instant switching (like browser tabs)
  const [modeStates, setModeStates] = useState<Record<string, ModeState>>({});;

  const { selectModel } = useAgent();
  const { data: threadsData = [] } = useThreads();
  
  // Sort and filter models: recommended first, then by priority, then alphabetically
  const availableModels = useMemo(() => {
    const models = modelsData?.models || [];
    return [...models].sort((a, b) => {
      // Recommended models first
      if (a.recommended !== b.recommended) {
        return a.recommended ? -1 : 1;
      }
      // Then by priority (higher priority first)
      const priorityA = a.priority || 0;
      const priorityB = b.priority || 0;
      if (priorityA !== priorityB) {
        return priorityB - priorityA;
      }
      // Finally alphabetically by display name
      const nameA = a.display_name || a.short_name || a.id || '';
      const nameB = b.display_name || b.short_name || b.id || '';
      return nameA.localeCompare(nameB);
    });
  }, [modelsData?.models]);
  
  // Filter accessible models based on subscription
  const accessibleModels = useMemo(() => {
    const filtered = availableModels.filter(model => {
      if (!model.requires_subscription) return true;
      return hasActiveSubscription;
    });
    
    return filtered;
  }, [availableModels, hasActiveSubscription]);
  
  // Log accessible models only when they actually change
  const prevAccessibleModelIdsRef = useRef<string>('');
  useEffect(() => {
    const currentIds = accessibleModels.map(m => m.id).join(',');
    if (currentIds !== prevAccessibleModelIdsRef.current) {
      log.log('🔍 [useChat] Accessible models:', {
        total: availableModels.length,
        accessible: accessibleModels.length,
        hasActiveSubscription,
        modelIds: accessibleModels.map(m => m.id),
      });
      prevAccessibleModelIdsRef.current = currentIds;
    }
  }, [accessibleModels, availableModels.length, hasActiveSubscription]);

  // Get stable accessible model IDs for dependency comparison
  const accessibleModelIds = useMemo(() => accessibleModels.map(m => m.id).join(','), [accessibleModels]);
  const accessibleModelsLength = accessibleModels.length;
  
  // Auto-select model when models first load and none is selected
  useEffect(() => {
    // Skip if still loading or no accessible models
    if (modelsLoading || accessibleModelsLength === 0) {
      return;
    }

    // If no model is selected, auto-select the best available model
    if (!selectedModelId) {
      const recommendedModel = accessibleModels.find(m => m.recommended);
      const fallbackModel = recommendedModel || accessibleModels[0];
      if (fallbackModel) {
        log.log('🔄 [useChat] Auto-selecting model (none selected):', fallbackModel.id);
        selectModel(fallbackModel.id);
      }
      return;
    }

    // If selected model is not accessible, switch to an accessible one
    const isModelAccessible = accessibleModels.some(m => m.id === selectedModelId);
    if (!isModelAccessible) {
      log.warn('⚠️ [useChat] Selected model is not accessible, switching:', selectedModelId);
      const recommendedModel = accessibleModels.find(m => m.recommended);
      const fallbackModel = recommendedModel || accessibleModels[0];
      if (fallbackModel) {
        log.log('🔄 [useChat] Auto-selecting accessible model:', fallbackModel.id);
        selectModel(fallbackModel.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModelId, accessibleModelIds, accessibleModelsLength, selectModel, modelsLoading]);
  
  // Determine current model to use
  const currentModel = useMemo(() => {
    // If models are still loading, return undefined
    if (modelsLoading) {
      return undefined;
    }
    
    // If a model is selected and accessible, use it
    if (selectedModelId) {
      const model = accessibleModels.find(m => m.id === selectedModelId);
      if (model) {
        return model.id;
      }
    }
    
    // Fallback to recommended model or first accessible model
    const recommendedModel = accessibleModels.find(m => m.recommended);
    const firstAccessibleModel = accessibleModels[0];
    const fallbackModel = recommendedModel?.id || firstAccessibleModel?.id;
    
    return fallbackModel;
  }, [selectedModelId, accessibleModels, modelsLoading]);
  
  // Log model selection only when it actually changes
  const prevModelSelectionRef = useRef<string>('');
  useEffect(() => {
    if (modelsLoading) return;
    
    const selectionKey = `${selectedModelId || 'none'}-${currentModel || 'none'}-${accessibleModels.length}`;
    if (selectionKey !== prevModelSelectionRef.current) {
      log.log('🔍 [useChat] Model selection:', {
        selectedModelId,
        currentModel,
        hasActiveSubscription,
        totalModels: availableModels.length,
        accessibleModels: accessibleModels.length,
        accessibleModelIds: accessibleModels.map(m => m.id),
        modelsLoading,
        modelsError: modelsError?.message,
      });
      
      if (currentModel) {
        log.log('✅ [useChat] Using selected accessible model:', currentModel);
      } else {
        log.warn('⚠️ [useChat] No accessible models available');
      }
      
      prevModelSelectionRef.current = selectionKey;
    }
  }, [selectedModelId, currentModel, accessibleModels, hasActiveSubscription, availableModels.length, modelsLoading, modelsError]);
  
  // Don't fetch for optimistic threads (they don't exist on server yet)
  const isOptimisticThread = activeThreadId?.startsWith('optimistic-') ?? false;
  const shouldFetchThread = !!activeThreadId && !isOptimisticThread;
  const shouldFetchMessages = !!activeThreadId && !isOptimisticThread;

  const { data: threadData, isLoading: isThreadLoading } = useThread(shouldFetchThread ? activeThreadId : undefined);
  const { data: messagesData, isLoading: isMessagesLoading, refetch: refetchMessages } = useMessages(shouldFetchMessages ? activeThreadId : undefined);
  const { data: activeRuns, refetch: refetchActiveRuns } = useActiveAgentRuns();

  useEffect(() => {
    if (threadData?.project?.sandbox?.id) {
      setActiveSandboxId(threadData.project.sandbox.id);
    } else if (!activeThreadId) {
      setActiveSandboxId(undefined);
    }
  }, [threadData, activeThreadId]);

  const sendMessageMutation = useSendMessageMutation();
  const unifiedAgentStartMutation = useUnifiedAgentStartMutation();
  const stopAgentRunMutation = useStopAgentRunMutation();
  const updateThreadMutation = useUpdateThread();
  const uploadFilesMutation = useUploadMultipleFiles();

  const lastStreamStartedRef = useRef<string | null>(null);
  const lastCompletedRunIdRef = useRef<string | null>(null);
  const lastErrorRunIdRef = useRef<string | null>(null); // Track runId that had error for retry

  const handleNewMessageFromStream = useCallback(
    (message: UnifiedMessage) => {
      if (!message.message_id) {
        log.warn(
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
          if (message.type === 'user') {
            // Helper to extract base content (before attachment references)
            const getBaseContent = (content: string | object): string => {
              try {
                const parsed = typeof content === 'string' ? JSON.parse(content) : content;
                const textContent = typeof parsed === 'object' && parsed?.content 
                  ? parsed.content 
                  : String(parsed);
                // Remove all attachment reference formats
                return textContent
                  .replace(/\[Pending Attachment: .*?\]/g, '')
                  .replace(/\[Uploaded File: .*?\]/g, '')
                  .replace(/\[Attached: .*? -> .*?\]/g, '')
                  .trim();
              } catch {
                return String(content);
              }
            };
            
            const newBaseContent = getBaseContent(message.content);
            
            const optimisticIndex = prev.findIndex(
              (m) =>
                m.type === 'user' &&
                m.message_id?.startsWith('optimistic-') &&
                getBaseContent(m.content) === newBaseContent,
            );
            if (optimisticIndex !== -1) {
              log.log('[STREAM] Replacing optimistic user message with real one');
              return prev.map((m, index) =>
                index === optimisticIndex ? message : m,
              );
            }
          }
          return [...prev, message];
        }
      });
    },
    [],
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
          setAgentRunId(null);
          setUserInitiatedRun(false); // Reset when stream ends
          break;
        case 'connecting':
        case 'streaming':
        case 'reconnecting':
          // Stream is active - safe to reset userInitiatedRun now
          // This allows isSendingMessage to become false once streaming is confirmed
          setUserInitiatedRun(false);
          break;
      }
    },
    [setAgentRunId],
  );

  const handleStreamError = useCallback((errorMessage: string) => {
    const lower = errorMessage.toLowerCase();
    const isExpected =
      lower.includes('not found') || lower.includes('agent run is not running');

    if (isExpected) {
      log.info(`[PAGE] Stream skipped for inactive run: ${errorMessage}`);
      return;
    }

    log.error(`[PAGE] Stream hook error: ${errorMessage}`);
  }, []);

  const handleStreamClose = useCallback(() => { }, []);

  const handleToolCallChunk = useCallback((message: UnifiedMessage) => {
    // Tool call chunk received - already handled by useAgentStream state
    // This callback can be used for additional processing if needed
  }, []);

  const {
    status: streamHookStatus,
    textContent: streamingTextContent,
    toolCall: streamingToolCall,
    error: streamError,
    agentRunId: currentHookRunId,
    retryCount: streamRetryCount,
    startStreaming,
    stopStreaming,
    resumeStream,
    clearError: clearStreamError,
    setError: setStreamError,
  } = useAgentStream(
    {
      onMessage: handleNewMessageFromStream,
      onStatusChange: handleStreamStatusChange,
      onError: handleStreamError,
      onClose: handleStreamClose,
      onToolCallChunk: handleToolCallChunk,
    },
    activeThreadId || '',
    setMessages,
    undefined,
  );

  const isStreaming = streamHookStatus === 'streaming' || streamHookStatus === 'connecting' || streamHookStatus === 'reconnecting';
  const isReconnecting = streamHookStatus === 'reconnecting';

  // Handle app state changes - resume stream when coming back to foreground
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      // App came to foreground from background/inactive
      if (
        appStateRef.current.match(/inactive|background/) && 
        nextAppState === 'active'
      ) {
        log.log('[useChat] App came to foreground, checking stream status');
        // Only try to resume if we have an active agent run
        if (currentHookRunId || agentRunId) {
          log.log('[useChat] Active run detected, resuming stream...');
          resumeStream();
        }
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [currentHookRunId, agentRunId, resumeStream]);

  const prevThreadIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const prevThread = prevThreadIdRef.current;
    const isThreadSwitch = prevThread && activeThreadId && prevThread !== activeThreadId;

    // Don't clear messages when transitioning from optimistic to real thread ID
    // This is NOT a real thread switch - it's the same conversation getting its real ID
    const isOptimisticToRealTransition = prevThread?.startsWith('optimistic-') && !activeThreadId?.startsWith('optimistic-');

    if (isThreadSwitch && !isOptimisticToRealTransition) {
      log.log('[useChat] Thread switched from', prevThread, 'to', activeThreadId);

      setMessages([]);
      lastStreamStartedRef.current = null;
    }

    prevThreadIdRef.current = activeThreadId;

    if (messagesData) {
      const unifiedMessages = messagesData as unknown as UnifiedMessage[];
      
      const shouldReload = messages.length === 0 || messagesData.length > messages.length + 50;
      
      if (shouldReload) {
        setMessages((prev) => {
          const serverIds = new Set(
            unifiedMessages.map((m) => m.message_id).filter(Boolean) as string[]
          );
          
          // Helper to get base content for matching optimistic to real messages
          const getBaseContent = (content: string | object): string => {
            try {
              const parsed = typeof content === 'string' ? JSON.parse(content) : content;
              const textContent = typeof parsed === 'object' && parsed?.content 
                ? parsed.content 
                : String(parsed);
              return textContent
                .replace(/\[Pending Attachment: .*?\]/g, '')
                .replace(/\[Uploaded File: .*?\]/g, '')
                .replace(/\[Attached: .*? -> .*?\]/g, '')
                .trim();
            } catch {
              return String(content);
            }
          };
          
          // Build set of server message base contents for matching
          const serverBaseContents = new Set(
            unifiedMessages
              .filter(m => m.type === 'user')
              .map(m => getBaseContent(m.content))
          );
          
          // Filter out optimistic messages that have matching server messages
          const localExtras = (prev || []).filter((m) => {
            // Keep messages without IDs
            if (!m.message_id) return true;
            
            // For optimistic messages, check if a matching server message exists
            if (typeof m.message_id === 'string' && m.message_id.startsWith('optimistic-')) {
              const baseContent = getBaseContent(m.content);
              const hasMatchingServerMessage = serverBaseContents.has(baseContent);
              if (hasMatchingServerMessage) {
                log.log('[useChat] Removing optimistic message - server version exists');
                return false; // Remove - server has the real version
              }
              return true; // Keep - still pending
            }
            
            // Keep messages not in server set
            return !serverIds.has(m.message_id as string);
          });
          
          const merged = [...unifiedMessages, ...localExtras].sort((a, b) => {
            const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
            const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
            return aTime - bTime;
          });
          
          log.log('🔄 [useChat] Merged messages:', {
            server: unifiedMessages.length,
            local: localExtras.length,
            total: merged.length,
          });
          
          return merged;
        });
      }
    }
  }, [messagesData, messages.length, activeThreadId]);

  useEffect(() => {
    if (!agentRunId || agentRunId === lastStreamStartedRef.current) {
      return;
    }

    if (userInitiatedRun) {
      log.log(`[useChat] Starting user-initiated stream for runId: ${agentRunId}`);
      lastStreamStartedRef.current = agentRunId;
      // Don't reset userInitiatedRun here - let it reset when streaming actually starts
      // This prevents the loader from disappearing during the connection phase
      startStreaming(agentRunId);
      return;
    }

    const activeRun = activeRuns?.find(r => r.id === agentRunId && r.status === 'running');
    if (activeRun) {
      log.log(`[useChat] Starting auto stream for runId: ${agentRunId}`);
      lastStreamStartedRef.current = agentRunId;
      startStreaming(agentRunId);
    }
  }, [agentRunId, startStreaming, userInitiatedRun, activeRuns]);

  useEffect(() => {
    // CRITICAL: Only react to completion if we actually started streaming for this run
    // This prevents false completion when streamHookStatus is stale from previous run
    if (!lastStreamStartedRef.current) {
      return;
    }

    // CRITICAL: Only process completion if the hook's current run matches what we started
    // This prevents stale 'completed' status from old run triggering completion for new run
    if (currentHookRunId !== lastStreamStartedRef.current) {
      log.log('[useChat] Ignoring stale status:', streamHookStatus, 'for run:', currentHookRunId, 'we started:', lastStreamStartedRef.current);
      return;
    }

    if (
      (streamHookStatus === 'completed' ||
        streamHookStatus === 'stopped' ||
        streamHookStatus === 'agent_not_running' ||
        streamHookStatus === 'error')
    ) {
      // Track the run ID that just completed to prevent immediate resume
      // Use currentHookRunId since that's the run that actually completed
      if (currentHookRunId) {
        lastCompletedRunIdRef.current = currentHookRunId;

        // On error, also track for retry - agent WAS started, don't resend
        if (streamHookStatus === 'error') {
          lastErrorRunIdRef.current = currentHookRunId;
          log.log('[useChat] Stored error runId for retry:', currentHookRunId);
        }
      }

      setAgentRunId(null);
      lastStreamStartedRef.current = null;

      if (streamHookStatus === 'completed' && activeThreadId) {
        log.log('[useChat] Streaming completed, refetching in background');
        setIsNewThreadOptimistic(false);

        queryClient.invalidateQueries({
          queryKey: chatKeys.messages(activeThreadId),
        });
        // Also invalidate activeRuns to get updated status
        queryClient.invalidateQueries({
          queryKey: ['activeRuns'],
        });
      }
    }
  }, [streamHookStatus, setAgentRunId, activeThreadId, queryClient, currentHookRunId]);

  // Check for running agents when thread becomes active or app comes to foreground
  useEffect(() => {
    if (!activeThreadId || !activeRuns) {
      return;
    }

    // Don't check for active runs immediately after stream completion
    // Wait a bit for the activeRuns query to update
    if (streamHookStatus === 'completed' || streamHookStatus === 'stopped') {
      return;
    }

    // If we don't have an agentRunId set but there's an active run for this thread, resume it
    const runningAgentForThread = activeRuns.find(
      run => run.thread_id === activeThreadId && run.status === 'running'
    );

    // Don't resume a run that we just completed or if user just initiated a new run
    if (
      runningAgentForThread &&
      !agentRunId &&
      !lastStreamStartedRef.current &&
      !userInitiatedRun && // Don't interfere with user-initiated runs
      runningAgentForThread.id !== lastCompletedRunIdRef.current
    ) {
      log.log('🔄 [useChat] Detected active run for current thread, resuming:', runningAgentForThread.id);
      setAgentRunId(runningAgentForThread.id);
    }
  }, [activeThreadId, activeRuns, agentRunId, streamHookStatus, userInitiatedRun]);

  const refreshMessages = useCallback(async () => {
    if (!activeThreadId || isStreaming) {
      log.log('[useChat] Cannot refresh: no active thread or streaming in progress');
      return;
    }
    
    log.log('[useChat] 🔄 Refreshing messages for thread:', activeThreadId);
    
    try {
      await refetchMessages();
      
      queryClient.invalidateQueries({ 
        queryKey: chatKeys.messages(activeThreadId) 
      });
      
      if (activeSandboxId) {
        queryClient.invalidateQueries({ 
          queryKey: ['files', 'sandbox', activeSandboxId],
          refetchType: 'all',
        });
      }
      
      log.log('[useChat] ✅ Messages refreshed successfully');
    } catch (error) {
      log.error('[useChat] ❌ Failed to refresh messages:', error);
      throw error;
    }
  }, [activeThreadId, isStreaming, refetchMessages, queryClient, activeSandboxId]);

  const loadThread = useCallback((threadId: string) => {
    log.log('[useChat] Loading thread:', threadId);

    // Don't load optimistic threads - they're already active
    if (threadId.startsWith('optimistic-')) {
      log.log('[useChat] Skipping load for optimistic thread');
      return;
    }

    log.log('🔄 [useChat] Thread loading initiated');

    // Clear all error state from previous thread
    setAgentRunId(null);
    lastErrorRunIdRef.current = null;
    clearStreamError(); // Clear error state from streaming hook
    
    stopStreaming();
    
    setSelectedToolData(null);
    setInputValue('');
    setAttachments([]);
    setIsNewThreadOptimistic(false);
    
    setMessages([]);
    
    // Reset Kortix Computer state when switching threads
    useKortixComputerStore.getState().reset();
    log.log('[useChat] Reset Kortix Computer state');
    
    setActiveThreadId(threadId);
    setModeViewState('thread');
    
    // Sync the selected mode with the thread's mode metadata
    const thread = threadsData.find((t: any) => t.thread_id === threadId);
    if (thread?.metadata?.mode) {
      log.log('[useChat] Syncing mode from thread metadata:', thread.metadata.mode);
      setSelectedQuickAction(thread.metadata.mode);
      setSelectedQuickActionOption(null);
    }
    
    // Reset messages cache to force fresh fetch from server (not stale cache)
    queryClient.resetQueries({ queryKey: chatKeys.messages(threadId) });
    
    // Reset active runs cache, then refetch to get fresh data from server
    log.log('🔍 [useChat] Checking for active agent runs...');
    queryClient.resetQueries({ queryKey: chatKeys.activeRuns() }).then(() => {
      return refetchActiveRuns();
    }).then(result => {
      if (result.data) {
        const runningAgentForThread = result.data.find(
          run => run.thread_id === threadId && run.status === 'running'
        );
        if (runningAgentForThread) {
          log.log('✅ [useChat] Found running agent, will auto-resume:', runningAgentForThread.id);
          setAgentRunId(runningAgentForThread.id);
        } else {
          log.log('ℹ️ [useChat] No active agent run found for this thread');
        }
      }
    }).catch(error => {
      log.error('❌ [useChat] Failed to refetch active runs:', error);
    });
  }, [stopStreaming, clearStreamError, refetchActiveRuns, queryClient, threadsData]);

  const startNewChat = useCallback(() => {
    log.log('[useChat] Starting new chat');
    setActiveThreadId(undefined);
    setAgentRunId(null);
    lastErrorRunIdRef.current = null;
    setMessages([]);
    setInputValue('');
    setAttachments([]);
    setSelectedToolData(null);
    setIsNewThreadOptimistic(false);
    setActiveSandboxId(undefined);
    clearStreamError(); // Clear any previous error state
    stopStreaming();
    
    // Reset Kortix Computer state when starting new chat
    useKortixComputerStore.getState().reset();
    log.log('[useChat] Reset Kortix Computer state for new chat');
  }, [stopStreaming, clearStreamError]);

  const updateThreadTitle = useCallback(async (newTitle: string) => {
    if (!activeThreadId) {
      log.warn('[useChat] Cannot update title: no active thread');
      return;
    }

    try {
      log.log('[useChat] Updating thread title to:', newTitle);
      await updateThreadMutation.mutateAsync({
        threadId: activeThreadId,
        data: { title: newTitle },
      });
      log.log('[useChat] Thread title updated successfully');
    } catch (error) {
      log.error('[useChat] Failed to update thread title:', error);
      throw error;
    }
  }, [activeThreadId, updateThreadMutation]);

  const sendMessage = useCallback(async (content: string, agentId: string, agentName: string) => {
    if (!content.trim() && attachments.length === 0) return;

    // Store params for retry functionality
    lastMessageParamsRef.current = { content, agentId, agentName };

    try {
      log.log('[useChat] Sending message:', { content, agentId, agentName, activeThreadId, attachmentsCount: attachments.length, selectedQuickAction, selectedQuickActionOption });
      
      for (const attachment of attachments) {
        const validation = validateFileSize(attachment.size);
        if (!validation.valid) {
          Alert.alert(t('common.error'), validation.error || t('attachments.fileTooLarge'));
          return;
        }
      }
      
      let currentThreadId = activeThreadId;
      
      if (!currentThreadId) {
        log.log('[useChat] Creating new thread via /agent/start with optimistic UI');

        // Store attachments before clearing for optimistic display
        const pendingAttachments = [...attachments];

        // Build optimistic content with attachment placeholders for preview
        let optimisticContent = content;
        if (pendingAttachments.length > 0) {
          const attachmentRefs = pendingAttachments
            .map(a => `[Pending Attachment: ${a.name}]`)
            .join('\n');
          optimisticContent = content ? `${content}\n\n${attachmentRefs}` : attachmentRefs;
        }

        // Generate optimistic thread ID for instant side menu display
        const optimisticThreadId = 'optimistic-thread-' + Date.now();
        const optimisticTimestamp = new Date().toISOString();

        // Create optimistic thread title from first ~50 chars of content
        const optimisticTitle = content.trim().substring(0, 50) + (content.length > 50 ? '...' : '');

        // Add optimistic thread to threads cache for instant side menu update
        queryClient.setQueryData(
          [...chatKeys.threads(), { projectId: undefined }],
          (oldThreads: any[] | undefined) => {
            const optimisticThread = {
              thread_id: optimisticThreadId,
              title: optimisticTitle || 'New Chat',
              created_at: optimisticTimestamp,
              updated_at: optimisticTimestamp,
              is_public: false,
              metadata: { mode: selectedQuickAction, isOptimistic: true },
            };
            log.log('✨ [useChat] Adding optimistic thread to side menu:', optimisticThreadId);
            return [optimisticThread, ...(oldThreads || [])];
          }
        );

        const optimisticUserMessage: UnifiedMessage = {
          message_id: 'optimistic-user-' + Date.now(),
          thread_id: optimisticThreadId,
          type: 'user',
          content: JSON.stringify({ content: optimisticContent }),
          metadata: JSON.stringify({
            pendingAttachments: pendingAttachments.map(a => ({
              uri: a.uri,
              name: a.name,
              type: a.type,
              size: a.size,
            }))
          }),
          is_llm_message: false,
          created_at: optimisticTimestamp,
          updated_at: optimisticTimestamp,
        };
        setMessages([optimisticUserMessage]);
        setIsNewThreadOptimistic(true);

        // CRITICAL: Set activeThreadId IMMEDIATELY so UI navigates to ThreadPage
        // This makes hasActiveThread = true, triggering instant navigation
        setActiveThreadId(optimisticThreadId);
        setModeViewState('thread');
        log.log('✨ [useChat] INSTANT navigation to thread + message display with', pendingAttachments.length, 'attachments');

        // Clear input and attachments immediately for instant feedback
        setInputValue('');
        setAttachments([]);
        
        // Convert attachments for upload (we need the data)
        const formDataFiles = pendingAttachments.length > 0
          ? await convertAttachmentsToFormDataFiles(pendingAttachments)
          : [];
        
        log.log('[useChat] Converted', formDataFiles.length, 'attachments for FormData');
        
        // Append hidden context for selected quick action options
        let messageWithContext = content;
        
        if (selectedQuickAction === 'slides' && selectedQuickActionOption) {
          messageWithContext += `\n\n----\n\n**Presentation Template:** ${selectedQuickActionOption}`;
          log.log('[useChat] Appended slides template context to new thread:', selectedQuickActionOption);
        }
        
        if (selectedQuickAction === 'image' && selectedQuickActionOption) {
          messageWithContext += `\n\n----\n\n**Image Style:** ${selectedQuickActionOption}`;
          log.log('[useChat] Appended image style context to new thread:', selectedQuickActionOption);
        }
        
        if (!currentModel) {
          log.error('❌ [useChat] No model available! Details:', {
            totalModels: availableModels.length,
            accessibleModels: accessibleModels.length,
            selectedModelId,
            hasActiveSubscription,
          });
          
          router.push({
            pathname: '/plans',
            params: { creditsExhausted: 'false' },
          });
          return;
        }
        
        log.log('🚀 [useChat] Starting agent with accessible model:', currentModel);
        
        try {
          // Detect mode from content (auto-detect overrides selected tab if content suggests different mode)
          const detectedMode = detectModeFromContent(content);
          const effectiveMode = detectedMode || selectedQuickAction;
          
          // Visually switch the tab if mode was auto-detected and is different from current
          if (detectedMode && detectedMode !== selectedQuickAction) {
            log.log('[useChat] 🎯 Auto-switching tab:', selectedQuickAction, '→', detectedMode);
            // Trigger haptic feedback to match manual tab switching experience
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setSelectedQuickAction(detectedMode);
            setSelectedQuickActionOption(null); // Clear any selected option when switching modes
          }
          
          // Build thread metadata with the effective mode
          const threadMetadata: Record<string, any> = {};
          if (effectiveMode) {
            threadMetadata.mode = effectiveMode;
            log.log('[useChat] Setting thread mode:', effectiveMode, 
              detectedMode ? '(auto-detected from content)' : '(from selected tab)');
          }
          
          const createResult = await unifiedAgentStartMutation.mutateAsync({
            prompt: messageWithContext,
            agentId: agentId,
            modelName: currentModel,
            files: formDataFiles as any,
            threadMetadata: Object.keys(threadMetadata).length > 0 ? threadMetadata : undefined,
          });

          currentThreadId = createResult.thread_id;

          // Replace optimistic thread with real thread in cache
          queryClient.setQueryData(
            [...chatKeys.threads(), { projectId: undefined }],
            (oldThreads: any[] | undefined) => {
              if (!oldThreads) return oldThreads;
              // Remove the optimistic thread, real thread will be added via invalidation
              const filtered = oldThreads.filter((t: any) => t.thread_id !== optimisticThreadId);
              log.log('✅ [useChat] Replaced optimistic thread with real thread:', currentThreadId);
              return filtered;
            }
          );

          // Update optimistic message's thread_id to real thread_id
          setMessages((prev) =>
            prev.map((m) =>
              m.thread_id === optimisticThreadId
                ? { ...m, thread_id: currentThreadId }
                : m
            )
          );

          setActiveThreadId(currentThreadId);

          // Invalidate to fetch real thread data (includes title generated by server)
          queryClient.invalidateQueries({
            queryKey: chatKeys.threads(),
          });
          queryClient.refetchQueries({
            queryKey: chatKeys.thread(currentThreadId),
          });

          if (createResult.agent_run_id) {
            log.log('[useChat] Starting INSTANT streaming:', createResult.agent_run_id);
            setUserInitiatedRun(true);
            setAgentRunId(createResult.agent_run_id);
            lastErrorRunIdRef.current = null; // Clear any previous error state
          }
        } catch (agentStartError: any) {
          log.error('[useChat] Error starting agent for new thread:', agentStartError);

          // Remove optimistic thread from cache on error
          queryClient.setQueryData(
            [...chatKeys.threads(), { projectId: undefined }],
            (oldThreads: any[] | undefined) => {
              if (!oldThreads) return oldThreads;
              const filtered = oldThreads.filter((t: any) => t.thread_id !== optimisticThreadId);
              log.log('❌ [useChat] Removed optimistic thread due to error');
              return filtered;
            }
          );

          // Clear optimistic state on error - go back to dashboard
          setMessages([]);
          setIsNewThreadOptimistic(false);
          setActiveThreadId(undefined); // Navigate back to HomePage

          const errorMessage = agentStartError?.message || '';
          const errorCode = agentStartError?.code || agentStartError?.detail?.error_code;
          
          // Handle concurrent agent run limit (AGENT_RUN_LIMIT_EXCEEDED)
          if (errorCode === 'AGENT_RUN_LIMIT_EXCEEDED' || (agentStartError?.status === 402 && errorMessage.includes('concurrent'))) {
            const detail = agentStartError?.detail || {};
            const runningCount = detail.running_count || 0;
            const limit = detail.limit || 1;
            const message = detail.message || `Maximum of ${limit} concurrent agent run${limit > 1 ? 's' : ''} allowed. You currently have ${runningCount} running.`;
            
            log.log('⚠️ Concurrent agent run limit reached');
            Alert.alert(
              'Concurrent Runs Limit Reached',
              `${message}\n\nPlease stop a running agent or wait for one to complete before starting a new one.`,
              [{ text: 'OK' }]
            );
            return;
          }
          
          // Handle project limit
          if (agentStartError?.status === 402 && errorCode === 'PROJECT_LIMIT_EXCEEDED') {
            log.log('💳 Project limit exceeded - opening billing modal');
            router.push({
              pathname: '/plans',
              params: { creditsExhausted: 'true' },
            });
            return;
          }
          
          throw agentStartError;
        }
      } else {
        log.log('[useChat] Sending to existing thread:', currentThreadId);
        
        // Store attachments before clearing for upload
        const pendingAttachments = [...attachments];
        
        // Build optimistic content with attachment placeholders for preview
        let optimisticContent = content;
        if (pendingAttachments.length > 0) {
          const attachmentRefs = pendingAttachments
            .map(a => `[Pending Attachment: ${a.name}]`)
            .join('\n');
          optimisticContent = content ? `${content}\n\n${attachmentRefs}` : attachmentRefs;
        }
        
        const optimisticUserMessage: UnifiedMessage = {
          message_id: 'optimistic-user-' + Date.now(),
          thread_id: currentThreadId,
          type: 'user',
          content: JSON.stringify({ content: optimisticContent }),
          metadata: JSON.stringify({ 
            pendingAttachments: pendingAttachments.map(a => ({
              uri: a.uri,
              name: a.name,
              type: a.type,
              size: a.size,
            }))
          }),
          is_llm_message: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        
        setMessages((prev) => [...prev, optimisticUserMessage]);
        log.log('✨ [useChat] INSTANT user message display for existing thread');
        
        // Clear input and attachments immediately for instant feedback
        setInputValue('');
        setAttachments([]);
        
        setIsNewThreadOptimistic(true);
        
        let messageContent = content;
        
        // Append hidden context for slides template
        if (selectedQuickAction === 'slides' && selectedQuickActionOption) {
          messageContent += `\n\n----\n\n**Presentation Template:** ${selectedQuickActionOption}`;
          log.log('[useChat] Appended slides template context:', selectedQuickActionOption);
        }
        
        // Append hidden context for image style
        if (selectedQuickAction === 'image' && selectedQuickActionOption) {
          messageContent += `\n\n----\n\n**Image Style:** ${selectedQuickActionOption}`;
          log.log('[useChat] Appended image style context:', selectedQuickActionOption);
        }
        
        if (pendingAttachments.length > 0) {
          const sandboxId = activeSandboxId;
          
          if (!sandboxId) {
            log.error('[useChat] No sandbox ID available for file upload');
            Alert.alert(
              t('common.error'),
              'Cannot upload files: sandbox not available'
            );
            return;
          }
          
          log.log('[useChat] Uploading', pendingAttachments.length, 'files to sandbox:', sandboxId);
          
          try {
            const filesToUpload = await convertAttachmentsToFormDataFiles(pendingAttachments);
            
            const uploadResults = await uploadFilesMutation.mutateAsync({
              sandboxId,
              files: filesToUpload.map(f => ({
                uri: f.uri,
                name: f.name,
                type: f.type,
              })),
            });
            
            log.log('[useChat] Files uploaded successfully:', uploadResults.length);
            
            const filePaths = uploadResults.map(result => result.path);
            const fileReferences = generateFileReferences(filePaths);
            
            messageContent = messageContent
              ? `${messageContent}\n\n${fileReferences}`
              : fileReferences;
              
            log.log('[useChat] Message with file references prepared');
          } catch (uploadError) {
            log.error('[useChat] File upload failed:', uploadError);
            
            Alert.alert(
              t('common.error'),
              t('attachments.uploadFailed') || 'Failed to upload files'
            );
            return;
          }
        }
        
        if (!currentModel) {
          log.error('❌ [useChat] No model available for sending message! Details:', {
            totalModels: availableModels.length,
            accessibleModels: accessibleModels.length,
            selectedModelId,
            hasActiveSubscription,
          });
          
          router.push({
            pathname: '/plans',
            params: { creditsExhausted: 'false' },
          });
          return;
        }
        
        log.log('🚀 [useChat] Sending message with accessible model:', currentModel);
        
        try {
          const result = await sendMessageMutation.mutateAsync({
            threadId: currentThreadId,
            message: messageContent,
            modelName: currentModel,
          });
          
          log.log('[useChat] Message sent, agent run started:', result.agentRunId);
          
          // Replace optimistic message with real message from server
          if (result.message) {
            setMessages((prev) => {
              // Helper to get base content for matching
              const getBaseContent = (msgContent: string | object): string => {
                try {
                  const parsed = typeof msgContent === 'string' ? JSON.parse(msgContent) : msgContent;
                  const textContent = typeof parsed === 'object' && parsed?.content 
                    ? parsed.content 
                    : String(parsed);
                  return textContent
                    .replace(/\[Pending Attachment: .*?\]/g, '')
                    .replace(/\[Uploaded File: .*?\]/g, '')
                    .replace(/\[Attached: .*? -> .*?\]/g, '')
                    .trim();
                } catch {
                  return String(msgContent);
                }
              };
              
              const realMessageContent = getBaseContent(result.message.content);
              
              // Find and replace optimistic message
              const optimisticIndex = prev.findIndex(
                (m) =>
                  m.type === 'user' &&
                  typeof m.message_id === 'string' &&
                  m.message_id.startsWith('optimistic-') &&
                  getBaseContent(m.content) === realMessageContent
              );
              
              if (optimisticIndex !== -1) {
                log.log('[useChat] ✅ Replacing optimistic message with real one');
                return prev.map((m, index) =>
                  index === optimisticIndex ? (result.message as UnifiedMessage) : m
                );
              }
              
              // If no optimistic found, just add the message
              log.log('[useChat] No optimistic message found to replace, adding new');
              return [...prev, result.message as UnifiedMessage];
            });
          }
          
          if (result.agentRunId) {
            log.log('[useChat] Starting INSTANT streaming for existing thread:', result.agentRunId);
            setUserInitiatedRun(true);
            setAgentRunId(result.agentRunId);
            lastErrorRunIdRef.current = null; // Clear any previous error state
          }
          
          setIsNewThreadOptimistic(false);
        } catch (sendMessageError: any) {
          log.error('[useChat] Error sending message to existing thread:', sendMessageError);
          
          const errorMessage = sendMessageError?.message || '';
          const errorCode = sendMessageError?.code || sendMessageError?.detail?.error_code;
          
          // Handle concurrent agent run limit (AGENT_RUN_LIMIT_EXCEEDED)
          if (errorCode === 'AGENT_RUN_LIMIT_EXCEEDED' || (sendMessageError?.status === 402 && errorMessage.includes('concurrent'))) {
            const detail = sendMessageError?.detail || {};
            const runningCount = detail.running_count || 0;
            const limit = detail.limit || 1;
            const message = detail.message || `Maximum of ${limit} concurrent agent run${limit > 1 ? 's' : ''} allowed. You currently have ${runningCount} running.`;
            
            log.log('⚠️ Concurrent agent run limit reached');
            Alert.alert(
              'Concurrent Runs Limit Reached',
              `${message}\n\nPlease stop a running agent or wait for one to complete before starting a new one.`,
              [{ text: 'OK' }]
            );
            return;
          }
          
          // Handle project limit
          if (sendMessageError?.status === 402 && errorCode === 'PROJECT_LIMIT_EXCEEDED') {
            log.log('💳 Project limit exceeded - opening billing modal');
            router.push({
              pathname: '/plans',
              params: { creditsExhausted: 'true' },
            });
            return;
          }
          throw sendMessageError;
        }
      }
    } catch (error: any) {
      log.error('[useChat] Error sending message:', error);
      throw error;
    }
  }, [
    activeThreadId,
    attachments,
    sendMessageMutation,
    unifiedAgentStartMutation,
    uploadFilesMutation,
    activeSandboxId,
    selectedQuickAction,
    selectedQuickActionOption,
    t,
  ]);

  const stopAgent = useCallback(async () => {
    // Use local agentRunId or fallback to the streaming hook's run ID
    const runIdToStop = agentRunId || currentHookRunId;
    
    log.log('[useChat] 🛑 Stopping agent run:', runIdToStop, '(local:', agentRunId, ', hook:', currentHookRunId, ')');
    
    // Always clear local state and stop streaming
    setAgentRunId(null);
    await stopStreaming();
    
    if (runIdToStop) {
      try {
        await stopAgentRunMutation.mutateAsync(runIdToStop);
        log.log('[useChat] ✅ Backend stop confirmed');
        
        queryClient.invalidateQueries({ queryKey: chatKeys.activeRuns() });
        
        if (activeThreadId) {
          queryClient.invalidateQueries({ queryKey: chatKeys.messages(activeThreadId) });
          refetchMessages();
        }
      } catch (error) {
        log.error('[useChat] ❌ Error stopping agent:', error);
      }
    } else {
      log.log('[useChat] ⚠️ No run ID to stop, but streaming was stopped');
    }
  }, [agentRunId, currentHookRunId, stopStreaming, stopAgentRunMutation, queryClient, activeThreadId, refetchMessages]);

  // Smart retry - NEVER resend if AI already responded, just refresh
  // IMPORTANT: Don't clear error until success - keep banner visible during retry
  const retryLastMessage = useCallback(async () => {
    // Prevent double-tapping
    if (isRetrying) return;
    
    setIsRetrying(true);
    
    // SIMPLE CHECK: If we have ANY assistant/tool messages, AI responded - just refresh, NEVER resend
    const hasAIResponse = messages.some(msg => 
      msg.type === 'assistant' || 
      msg.type === 'tool' || 
      (msg.content && typeof msg.content === 'object' && 'role' in msg.content && msg.content.role === 'assistant')
    );
    
    if (hasAIResponse) {
      log.log('[useChat] Retry: AI already responded, refreshing thread (NOT resending)');
      
      // Refresh messages to get latest state from server
      if (activeThreadId) {
        log.log('[useChat] Retry: Refreshing messages and checking for active runs...');
        try {
          // CRITICAL: Remove cached data completely so fetchQuery forces network
          await queryClient.removeQueries({ queryKey: chatKeys.messages(activeThreadId) });
          await queryClient.removeQueries({ queryKey: chatKeys.activeRuns() });
          
          // Use fetchQuery which THROWS on network error (unlike refetch which returns cached data)
          await refetchMessages();
          
          // fetchQuery throws on error - if we get here, network is working
          const activeRuns = await queryClient.fetchQuery({
            queryKey: chatKeys.activeRuns(),
            staleTime: 0, // Force fresh fetch
          });
          
          log.log('[useChat] Retry: Got fresh activeRuns data, count:', activeRuns?.length ?? 0);
          
          if (activeRuns) {
            const runningAgent = activeRuns.find(
              (run: { thread_id: string; status: string; id: string }) => 
                run.thread_id === activeThreadId && run.status === 'running'
            );
            if (runningAgent) {
              log.log('[useChat] Retry: Found running agent, reconnecting:', runningAgent.id);
              setAgentRunId(runningAgent.id);
              lastErrorRunIdRef.current = null;
              // SUCCESS! Clear error and start streaming
              clearStreamError();
              await startStreaming(runningAgent.id);
            } else {
              log.log('[useChat] Retry: No running agent, messages refreshed - clearing error');
              lastErrorRunIdRef.current = null;
              // SUCCESS! Got fresh messages, agent finished
              clearStreamError();
            }
          } else {
            log.log('[useChat] Retry: No active runs, clearing error');
            lastErrorRunIdRef.current = null;
            clearStreamError();
          }
        } catch (err) {
          // fetchQuery throws on network error - keep the error banner!
          log.error('[useChat] Retry: Network error - keeping error banner:', err);
          setStreamError('Connection failed - tap to retry');
        }
      }
      setIsRetrying(false);
      return;
    }
    
    // Also check runId as backup
    const runId = currentHookRunId || agentRunId || lastErrorRunIdRef.current;
    if (runId) {
      log.log('[useChat] Retry: Has runId, refreshing...', { runId });
      
      if (activeThreadId) {
        try {
          // CRITICAL: Remove cached data completely so fetchQuery forces network
          await queryClient.removeQueries({ queryKey: chatKeys.messages(activeThreadId) });
          await queryClient.removeQueries({ queryKey: chatKeys.activeRuns() });
          
          await refetchMessages();
          
          // fetchQuery throws on error - if we get here, network is working
          const activeRuns = await queryClient.fetchQuery({
            queryKey: chatKeys.activeRuns(),
            staleTime: 0, // Force fresh fetch
          });
          
          log.log('[useChat] Retry: Got fresh activeRuns data (runId path), count:', activeRuns?.length ?? 0);
          
          if (activeRuns) {
            const runningAgent = activeRuns.find(
              (run: { thread_id: string; status: string; id: string }) => 
                run.thread_id === activeThreadId && run.status === 'running'
            );
            if (runningAgent) {
              log.log('[useChat] Retry: Found running agent, reconnecting:', runningAgent.id);
              setAgentRunId(runningAgent.id);
              lastErrorRunIdRef.current = null;
              // SUCCESS! Clear error and start streaming
              clearStreamError();
              await startStreaming(runningAgent.id);
            } else {
              log.log('[useChat] Retry: No running agent with runId backup, clearing error');
              lastErrorRunIdRef.current = null;
              clearStreamError();
            }
          } else {
            log.log('[useChat] Retry: No active runs (runId path), clearing error');
            lastErrorRunIdRef.current = null;
            clearStreamError();
          }
        } catch (err) {
          // fetchQuery throws on network error - keep the error banner!
          log.error('[useChat] Retry: Network error (runId path) - keeping error banner:', err);
          setStreamError('Connection failed - tap to retry');
        }
      }
      setIsRetrying(false);
      return;
    }
    
    // ONLY resend if: no AI response AND no runId - agent truly never started
    if (!lastMessageParamsRef.current) {
      log.warn('[useChat] No message to retry');
      if (activeThreadId) {
        try {
          await refetchMessages();
          clearStreamError();
        } catch {
          setStreamError('Connection failed - tap to retry');
        }
      }
      setIsRetrying(false);
      return;
    }
    
    const { content, agentId, agentName } = lastMessageParamsRef.current;
    log.log('[useChat] Retry: No AI response, no runId - resending message');
    clearStreamError(); // Clear before resending
    sendMessage(content, agentId, agentName);
    setIsRetrying(false);
  }, [isRetrying, messages, currentHookRunId, agentRunId, clearStreamError, setStreamError, startStreaming, activeThreadId, refetchMessages, refetchActiveRuns, queryClient, sendMessage]);

  const addAttachment = useCallback((attachment: Attachment) => {
    setAttachments(prev => [...prev, attachment]);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleTakePicture = useCallback(async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    
    if (status !== 'granted') {
      Alert.alert(
        t('permissions.cameraTitle'),
        t('permissions.cameraMessage')
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      addAttachment({
        type: 'image',
        uri: asset.uri,
        name: asset.fileName || `photo_${Date.now()}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
      });
    }
    
    setIsAttachmentDrawerVisible(false);
  }, [t, addAttachment]);

  const handleChooseImages = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    
    if (status !== 'granted') {
      Alert.alert(
        t('permissions.galleryTitle'),
        t('permissions.galleryMessage')
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.8,
    });

    if (!result.canceled) {
      result.assets.forEach(asset => {
        addAttachment({
          type: 'image',
          uri: asset.uri,
          name: asset.fileName || `image_${Date.now()}.jpg`,
          mimeType: asset.mimeType || 'image/jpeg',
        });
      });
    }
    
    setIsAttachmentDrawerVisible(false);
  }, [t, addAttachment]);

  const handleChooseFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (!result.canceled) {
        result.assets.forEach(asset => {
          addAttachment({
            type: 'document',
            uri: asset.uri,
            name: asset.name,
            size: asset.size || undefined,
            mimeType: asset.mimeType || undefined,
          });
        });
      }
    } catch (error) {
      log.error('Error picking document:', error);
    }
    
    setIsAttachmentDrawerVisible(false);
  }, [addAttachment]);

  const handleQuickAction = useCallback((actionId: string) => {
    log.log('[useChat] 🔄 Switching mode:', selectedQuickAction, '→', actionId);
    
    // Don't do anything if switching to the same mode
    if (actionId === selectedQuickAction) {
      return;
    }
    
    // Save current mode's FULL state before switching (like saving a browser tab)
    if (selectedQuickAction) {
      log.log('[useChat] 💾 Saving full state for mode:', selectedQuickAction, {
        threadId: activeThreadId,
        messagesCount: messages.length,
        agentRunId,
        viewState: modeViewState,
      });
      setModeStates(prev => ({
        ...prev,
        [selectedQuickAction]: {
          threadId: activeThreadId,
          messages: messages,
          agentRunId: agentRunId,
          sandboxId: activeSandboxId,
          viewState: modeViewState,
          inputValue: inputValue,
          attachments: attachments,
          selectedOption: selectedQuickActionOption,
        },
      }));
    }
    
    // Switch to the new mode
    setSelectedQuickAction(actionId);
    
    // Check if the target mode has saved state (instant restore like browser tab)
    const savedState = modeStates[actionId];
    if (savedState && (savedState.threadId || savedState.messages.length > 0)) {
      log.log('[useChat] ⚡ Instant restore for mode:', actionId, {
        threadId: savedState.threadId,
        messagesCount: savedState.messages.length,
        agentRunId: savedState.agentRunId,
        viewState: savedState.viewState,
      });
      
      // Instantly restore all state - no reloading!
      setActiveThreadId(savedState.threadId);
      setMessages(savedState.messages);
      setAgentRunId(savedState.agentRunId);
      setActiveSandboxId(savedState.sandboxId);
      setModeViewState(savedState.viewState);
      setInputValue(savedState.inputValue);
      setAttachments(savedState.attachments);
      setSelectedQuickActionOption(savedState.selectedOption);
      
      // If there was a running agent, reconnect to stream (quick operation)
      if (savedState.agentRunId && savedState.threadId) {
        log.log('[useChat] 🔌 Reconnecting to stream:', savedState.agentRunId);
        lastStreamStartedRef.current = null; // Allow stream to restart
        startStreaming(savedState.agentRunId);
      }
    } else {
      // No saved state - show fresh thread list for new mode
      log.log('[useChat] 📋 Fresh mode, showing thread list:', actionId);
      // Stop current streaming (agent keeps running on server)
      stopStreaming();
      setAgentRunId(null);
      setActiveThreadId(undefined);
      setMessages([]);
      setSelectedToolData(null);
      setInputValue('');
      setAttachments([]);
      setSelectedQuickActionOption(null);
      setModeViewState('thread-list');
    }
  }, [
    selectedQuickAction, 
    activeThreadId, 
    messages, 
    agentRunId, 
    activeSandboxId, 
    modeViewState, 
    inputValue, 
    attachments, 
    selectedQuickActionOption,
    modeStates, 
    stopStreaming, 
    startStreaming,
  ]);

  // Show the thread list for current mode
  const showModeThreadList = useCallback(() => {
    log.log('[useChat] 📋 Going back to thread list for mode:', selectedQuickAction);
    setModeViewState('thread-list');
    
    // Clear the saved state for current mode when user explicitly goes back
    if (selectedQuickAction) {
      setModeStates(prev => {
        const updated = { ...prev };
        delete updated[selectedQuickAction];
        return updated;
      });
    }
    
    // Clear active thread when going to list view
    setActiveThreadId(undefined);
    setMessages([]);
    setAgentRunId(null);
    stopStreaming();
  }, [stopStreaming, selectedQuickAction]);

  // Open a specific thread (used from thread list)
  const showModeThread = useCallback((threadId: string) => {
    log.log('[useChat] Opening thread from list:', threadId);
    loadThread(threadId);
    setModeViewState('thread');
  }, [loadThread]);

  const clearQuickAction = useCallback(() => {
    setSelectedQuickAction(null);
    setSelectedQuickActionOption(null);
  }, []);

  const getPlaceholder = useCallback(() => {
    if (selectedQuickAction) {
      switch (selectedQuickAction) {
        case 'summarize':
          return t('quickActions.summarizePlaceholder') || 'What would you like to summarize?';
        case 'translate':
          return t('quickActions.translatePlaceholder') || 'What would you like to translate?';
        case 'explain':
          return t('quickActions.explainPlaceholder') || 'What would you like explained?';
        default:
          return t('chat.inputPlaceholder') || 'Type a message...';
      }
    }
    return t('chat.inputPlaceholder') || 'Type a message...';
  }, [selectedQuickAction, t]);

  const openAttachmentDrawer = useCallback(() => {
    setIsAttachmentDrawerVisible(true);
  }, []);

  const closeAttachmentDrawer = useCallback(() => {
    setIsAttachmentDrawerVisible(false);
  }, []);


  const transcribeAndAddToInput = useCallback(async (audioUri: string) => {
    try {
      setIsTranscribing(true);
      
      const validation = await validateAudioFile(audioUri);
      if (!validation.valid) {
        Alert.alert(t('common.error'), validation.error || 'Invalid audio file');
        return;
      }

      const transcript = await transcribeAudio(audioUri);
      
      if (transcript) {
        setInputValue(prev => {
          const separator = prev.trim() ? ' ' : '';
          return prev + separator + transcript;
        });
      }
    } catch (error) {
      log.error('Transcription error:', error);
      Alert.alert(
        t('common.error'),
        t('audio.transcriptionFailed') || 'Failed to transcribe audio'
      );
    } finally {
      setIsTranscribing(false);
    }
  }, [t]);

  const activeThread = useMemo(() => {
    if (!activeThreadId) return null;

    // For optimistic threads OR during optimistic-to-real transition, create synthetic data
    // This prevents flicker when threadData hasn't loaded yet
    const needsSyntheticData = activeThreadId.startsWith('optimistic-') ||
      (isNewThreadOptimistic && !threadData);

    if (needsSyntheticData) {
      const firstUserMessage = messages.find(m => m.type === 'user');
      let optimisticTitle = 'New Chat';
      if (firstUserMessage) {
        try {
          const parsed = JSON.parse(firstUserMessage.content as string);
          const content = parsed.content || '';
          optimisticTitle = content.substring(0, 50) + (content.length > 50 ? '...' : '');
        } catch {
          // Use default title
        }
      }
      return {
        id: activeThreadId,
        title: optimisticTitle,
        messages,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    if (!threadData) return null;

    return {
      id: activeThreadId,
      title: threadData.title,
      messages,
      createdAt: new Date(threadData.created_at),
      updatedAt: new Date(threadData.updated_at),
    };
  }, [activeThreadId, threadData, messages, isNewThreadOptimistic]);

  const isLoading = (isThreadLoading || isMessagesLoading) && 
    !!activeThreadId && 
    !isNewThreadOptimistic && 
    messages.length === 0;

  return {
    activeThread,
    threads: threadsData,
    loadThread,
    startNewChat,
    updateThreadTitle,
    hasActiveThread: !!activeThreadId,
    refreshMessages,
    activeSandboxId,
    
    messages,
    streamingContent: streamingTextContent,
    streamingToolCall,
    isStreaming,
    isReconnecting,
    retryCount: streamRetryCount,
    
    sendMessage,
    stopAgent,
    
    inputValue,
    setInputValue,
    attachments,
    addAttachment,
    removeAttachment,
    
    selectedToolData,
    setSelectedToolData,
    
    isLoading,
    // Keep isSendingMessage true during the gap between mutation completing and stream starting
    // This prevents the loader from disappearing briefly during the transition
    isSendingMessage: sendMessageMutation.isPending || unifiedAgentStartMutation.isPending || (userInitiatedRun && !isStreaming),
    isAgentRunning: isStreaming,
    // Expose for ThreadPage to skip pushToTop on first message
    isNewThreadOptimistic,
    
    // Error state for stream errors
    streamError: streamError,
    retryLastMessage,
    isRetrying,
    hasActiveRun: !!(agentRunId || currentHookRunId || lastErrorRunIdRef.current),
    
    handleTakePicture,
    handleChooseImages,
    handleChooseFiles,
    
    selectedQuickAction,
    selectedQuickActionOption,
    handleQuickAction,
    setSelectedQuickActionOption,
    clearQuickAction,
    getPlaceholder,
    
    // Mode view state
    modeViewState,
    showModeThreadList,
    showModeThread,
    
    isAttachmentDrawerVisible,
    openAttachmentDrawer,
    closeAttachmentDrawer,
    
    transcribeAndAddToInput,
    isTranscribing,
  };
}
