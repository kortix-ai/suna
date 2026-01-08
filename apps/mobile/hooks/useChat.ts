import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Alert, Keyboard } from 'react-native';
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
      console.log('🔍 [useChat] Accessible models:', {
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
        console.log('🔄 [useChat] Auto-selecting model (none selected):', fallbackModel.id);
        selectModel(fallbackModel.id);
      }
      return;
    }

    // If selected model is not accessible, switch to an accessible one
    const isModelAccessible = accessibleModels.some(m => m.id === selectedModelId);
    if (!isModelAccessible) {
      console.warn('⚠️ [useChat] Selected model is not accessible, switching:', selectedModelId);
      const recommendedModel = accessibleModels.find(m => m.recommended);
      const fallbackModel = recommendedModel || accessibleModels[0];
      if (fallbackModel) {
        console.log('🔄 [useChat] Auto-selecting accessible model:', fallbackModel.id);
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
      console.log('🔍 [useChat] Model selection:', {
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
        console.log('✅ [useChat] Using selected accessible model:', currentModel);
      } else {
        console.warn('⚠️ [useChat] No accessible models available');
      }
      
      prevModelSelectionRef.current = selectionKey;
    }
  }, [selectedModelId, currentModel, accessibleModels, hasActiveSubscription, availableModels.length, modelsLoading, modelsError]);
  
  const shouldFetchThread = !!activeThreadId;
  const shouldFetchMessages = !!activeThreadId;

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
              console.log('[STREAM] Replacing optimistic user message with real one');
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
          break;
        case 'connecting':
          break;
        case 'streaming':
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
      console.info(`[PAGE] Stream skipped for inactive run: ${errorMessage}`);
      return;
    }

    console.error(`[PAGE] Stream hook error: ${errorMessage}`);
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
    startStreaming,
    stopStreaming,
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

  const isStreaming = streamHookStatus === 'streaming' || streamHookStatus === 'connecting';

  const prevThreadIdRef = useRef<string | undefined>(undefined);
  
  useEffect(() => {
    const prevThread = prevThreadIdRef.current;
    const isThreadSwitch = prevThread && activeThreadId && prevThread !== activeThreadId;
    
    if (isThreadSwitch) {
      console.log('[useChat] Thread switched from', prevThread, 'to', activeThreadId);
      
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
                console.log('[useChat] Removing optimistic message - server version exists');
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
          
          console.log('🔄 [useChat] Merged messages:', {
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
      console.log(`[useChat] Starting user-initiated stream for runId: ${agentRunId}`);
      lastStreamStartedRef.current = agentRunId;
      setUserInitiatedRun(false);
      startStreaming(agentRunId);
      return;
    }

    const activeRun = activeRuns?.find(r => r.id === agentRunId && r.status === 'running');
    if (activeRun) {
      console.log(`[useChat] Starting auto stream for runId: ${agentRunId}`);
      lastStreamStartedRef.current = agentRunId;
      startStreaming(agentRunId);
    }
  }, [agentRunId, startStreaming, userInitiatedRun, activeRuns]);

  useEffect(() => {
    if (
      (streamHookStatus === 'completed' ||
        streamHookStatus === 'stopped' ||
        streamHookStatus === 'agent_not_running' ||
        streamHookStatus === 'error')
    ) {
      // Track the run ID that just completed to prevent immediate resume
      if (agentRunId) {
        lastCompletedRunIdRef.current = agentRunId;
      }
      
      setAgentRunId(null);
      lastStreamStartedRef.current = null;
      
      if (streamHookStatus === 'completed' && activeThreadId) {
        console.log('[useChat] Streaming completed, refetching in background');
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
  }, [streamHookStatus, setAgentRunId, activeThreadId, queryClient, agentRunId]);

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

    // Don't resume a run that we just completed
    if (
      runningAgentForThread && 
      !agentRunId && 
      !lastStreamStartedRef.current &&
      runningAgentForThread.id !== lastCompletedRunIdRef.current
    ) {
      console.log('🔄 [useChat] Detected active run for current thread, resuming:', runningAgentForThread.id);
      setAgentRunId(runningAgentForThread.id);
    }
  }, [activeThreadId, activeRuns, agentRunId, streamHookStatus]);

  const refreshMessages = useCallback(async () => {
    if (!activeThreadId || isStreaming) {
      console.log('[useChat] Cannot refresh: no active thread or streaming in progress');
      return;
    }
    
    console.log('[useChat] 🔄 Refreshing messages for thread:', activeThreadId);
    
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
      
      console.log('[useChat] ✅ Messages refreshed successfully');
    } catch (error) {
      console.error('[useChat] ❌ Failed to refresh messages:', error);
      throw error;
    }
  }, [activeThreadId, isStreaming, refetchMessages, queryClient, activeSandboxId]);

  const loadThread = useCallback((threadId: string) => {
    console.log('[useChat] Loading thread:', threadId);
    console.log('🔄 [useChat] Thread loading initiated');
    
    setAgentRunId(null);
    
    stopStreaming();
    
    setSelectedToolData(null);
    setInputValue('');
    setAttachments([]);
    setIsNewThreadOptimistic(false);
    
    setMessages([]);
    
    setActiveThreadId(threadId);
    setModeViewState('thread');
    
    // Sync the selected mode with the thread's mode metadata
    const thread = threadsData.find((t: any) => t.thread_id === threadId);
    if (thread?.metadata?.mode) {
      console.log('[useChat] Syncing mode from thread metadata:', thread.metadata.mode);
      setSelectedQuickAction(thread.metadata.mode);
      setSelectedQuickActionOption(null);
    }
    
    // Refetch active runs to check if there's a running agent for this thread
    console.log('🔍 [useChat] Checking for active agent runs...');
    refetchActiveRuns().then(result => {
      if (result.data) {
        const runningAgentForThread = result.data.find(
          run => run.thread_id === threadId && run.status === 'running'
        );
        if (runningAgentForThread) {
          console.log('✅ [useChat] Found running agent, will auto-resume:', runningAgentForThread.id);
          setAgentRunId(runningAgentForThread.id);
        } else {
          console.log('ℹ️ [useChat] No active agent run found for this thread');
        }
      }
    }).catch(error => {
      console.error('❌ [useChat] Failed to refetch active runs:', error);
    });
  }, [stopStreaming, refetchActiveRuns, threadsData]);

  const startNewChat = useCallback(() => {
    console.log('[useChat] Starting new chat');
    setActiveThreadId(undefined);
    setAgentRunId(null);
    setMessages([]);
    setInputValue('');
    setAttachments([]);
    setSelectedToolData(null);
    setIsNewThreadOptimistic(false);
    setActiveSandboxId(undefined);
    stopStreaming();
  }, [stopStreaming]);

  const updateThreadTitle = useCallback(async (newTitle: string) => {
    if (!activeThreadId) {
      console.warn('[useChat] Cannot update title: no active thread');
      return;
    }

    try {
      console.log('[useChat] Updating thread title to:', newTitle);
      await updateThreadMutation.mutateAsync({
        threadId: activeThreadId,
        data: { title: newTitle },
      });
      console.log('[useChat] Thread title updated successfully');
    } catch (error) {
      console.error('[useChat] Failed to update thread title:', error);
      throw error;
    }
  }, [activeThreadId, updateThreadMutation]);

  const sendMessage = useCallback(async (content: string, agentId: string, agentName: string) => {
    if (!content.trim() && attachments.length === 0) return;

    try {
      console.log('[useChat] Sending message:', { content, agentId, agentName, activeThreadId, attachmentsCount: attachments.length, selectedQuickAction, selectedQuickActionOption });
      
      for (const attachment of attachments) {
        const validation = validateFileSize(attachment.size);
        if (!validation.valid) {
          Alert.alert(t('common.error'), validation.error || t('attachments.fileTooLarge'));
          return;
        }
      }
      
      let currentThreadId = activeThreadId;
      
      if (!currentThreadId) {
        console.log('[useChat] Creating new thread via /agent/start with optimistic UI');
        
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
        
        const optimisticUserMessage: UnifiedMessage = {
          message_id: 'optimistic-user-' + Date.now(),
          thread_id: 'optimistic',
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
        setMessages([optimisticUserMessage]);
        setIsNewThreadOptimistic(true);
        console.log('✨ [useChat] INSTANT user message display with', pendingAttachments.length, 'attachments');
        
        // Clear input and attachments immediately for instant feedback
        setInputValue('');
        setAttachments([]);
        
        // Convert attachments for upload (we need the data)
        const formDataFiles = pendingAttachments.length > 0
          ? await convertAttachmentsToFormDataFiles(pendingAttachments)
          : [];
        
        console.log('[useChat] Converted', formDataFiles.length, 'attachments for FormData');
        
        // Append hidden context for selected quick action options
        let messageWithContext = content;
        
        if (selectedQuickAction === 'slides' && selectedQuickActionOption) {
          messageWithContext += `\n\n----\n\n**Presentation Template:** ${selectedQuickActionOption}`;
          console.log('[useChat] Appended slides template context to new thread:', selectedQuickActionOption);
        }
        
        if (selectedQuickAction === 'image' && selectedQuickActionOption) {
          messageWithContext += `\n\n----\n\n**Image Style:** ${selectedQuickActionOption}`;
          console.log('[useChat] Appended image style context to new thread:', selectedQuickActionOption);
        }
        
        if (!currentModel) {
          console.error('❌ [useChat] No model available! Details:', {
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
        
        console.log('🚀 [useChat] Starting agent with accessible model:', currentModel);
        
        try {
          // Detect mode from content (auto-detect overrides selected tab if content suggests different mode)
          const detectedMode = detectModeFromContent(content);
          const effectiveMode = detectedMode || selectedQuickAction;
          
          // Visually switch the tab if mode was auto-detected and is different from current
          if (detectedMode && detectedMode !== selectedQuickAction) {
            console.log('[useChat] 🎯 Auto-switching tab:', selectedQuickAction, '→', detectedMode);
            // Trigger haptic feedback to match manual tab switching experience
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setSelectedQuickAction(detectedMode);
            setSelectedQuickActionOption(null); // Clear any selected option when switching modes
          }
          
          // Build thread metadata with the effective mode
          const threadMetadata: Record<string, any> = {};
          if (effectiveMode) {
            threadMetadata.mode = effectiveMode;
            console.log('[useChat] Setting thread mode:', effectiveMode, 
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
      
          setActiveThreadId(currentThreadId);
          
          queryClient.refetchQueries({ 
            queryKey: chatKeys.thread(currentThreadId),
          });
          
          if (createResult.agent_run_id) {
            console.log('[useChat] Starting INSTANT streaming:', createResult.agent_run_id);
            setUserInitiatedRun(true);
            setAgentRunId(createResult.agent_run_id);
          }
        } catch (agentStartError: any) {
          console.error('[useChat] Error starting agent for new thread:', agentStartError);
          
          const errorMessage = agentStartError?.message || '';
          const errorCode = agentStartError?.code || agentStartError?.detail?.error_code;
          
          // Handle concurrent agent run limit (AGENT_RUN_LIMIT_EXCEEDED)
          if (errorCode === 'AGENT_RUN_LIMIT_EXCEEDED' || (agentStartError?.status === 402 && errorMessage.includes('concurrent'))) {
            const detail = agentStartError?.detail || {};
            const runningCount = detail.running_count || 0;
            const limit = detail.limit || 1;
            const message = detail.message || `Maximum of ${limit} concurrent agent run${limit > 1 ? 's' : ''} allowed. You currently have ${runningCount} running.`;
            
            console.log('⚠️ Concurrent agent run limit reached');
            Alert.alert(
              'Concurrent Runs Limit Reached',
              `${message}\n\nPlease stop a running agent or wait for one to complete before starting a new one.`,
              [{ text: 'OK' }]
            );
            return;
          }
          
          // Handle project limit
          if (agentStartError?.status === 402 && errorCode === 'PROJECT_LIMIT_EXCEEDED') {
            console.log('💳 Project limit exceeded - opening billing modal');
            router.push({
              pathname: '/plans',
              params: { creditsExhausted: 'true' },
            });
            return;
          }
          
          throw agentStartError;
        }
      } else {
        console.log('[useChat] Sending to existing thread:', currentThreadId);
        
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
        console.log('✨ [useChat] INSTANT user message display for existing thread');
        
        // Clear input and attachments immediately for instant feedback
        setInputValue('');
        setAttachments([]);
        
        setIsNewThreadOptimistic(true);
        
        let messageContent = content;
        
        // Append hidden context for slides template
        if (selectedQuickAction === 'slides' && selectedQuickActionOption) {
          messageContent += `\n\n----\n\n**Presentation Template:** ${selectedQuickActionOption}`;
          console.log('[useChat] Appended slides template context:', selectedQuickActionOption);
        }
        
        // Append hidden context for image style
        if (selectedQuickAction === 'image' && selectedQuickActionOption) {
          messageContent += `\n\n----\n\n**Image Style:** ${selectedQuickActionOption}`;
          console.log('[useChat] Appended image style context:', selectedQuickActionOption);
        }
        
        if (pendingAttachments.length > 0) {
          const sandboxId = activeSandboxId;
          
          if (!sandboxId) {
            console.error('[useChat] No sandbox ID available for file upload');
            Alert.alert(
              t('common.error'),
              'Cannot upload files: sandbox not available'
            );
            return;
          }
          
          console.log('[useChat] Uploading', pendingAttachments.length, 'files to sandbox:', sandboxId);
          
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
            
            console.log('[useChat] Files uploaded successfully:', uploadResults.length);
            
            const filePaths = uploadResults.map(result => result.path);
            const fileReferences = generateFileReferences(filePaths);
            
            messageContent = messageContent
              ? `${messageContent}\n\n${fileReferences}`
              : fileReferences;
              
            console.log('[useChat] Message with file references prepared');
          } catch (uploadError) {
            console.error('[useChat] File upload failed:', uploadError);
            
            Alert.alert(
              t('common.error'),
              t('attachments.uploadFailed') || 'Failed to upload files'
            );
            return;
          }
        }
        
        if (!currentModel) {
          console.error('❌ [useChat] No model available for sending message! Details:', {
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
        
        console.log('🚀 [useChat] Sending message with accessible model:', currentModel);
        
        try {
          const result = await sendMessageMutation.mutateAsync({
            threadId: currentThreadId,
            message: messageContent,
            modelName: currentModel,
          });
          
          console.log('[useChat] Message sent, agent run started:', result.agentRunId);
          
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
                console.log('[useChat] ✅ Replacing optimistic message with real one');
                return prev.map((m, index) =>
                  index === optimisticIndex ? (result.message as UnifiedMessage) : m
                );
              }
              
              // If no optimistic found, just add the message
              console.log('[useChat] No optimistic message found to replace, adding new');
              return [...prev, result.message as UnifiedMessage];
            });
          }
          
          if (result.agentRunId) {
            console.log('[useChat] Starting INSTANT streaming for existing thread:', result.agentRunId);
            setUserInitiatedRun(true);
            setAgentRunId(result.agentRunId);
          }
          
          setIsNewThreadOptimistic(false);
        } catch (sendMessageError: any) {
          console.error('[useChat] Error sending message to existing thread:', sendMessageError);
          
          const errorMessage = sendMessageError?.message || '';
          const errorCode = sendMessageError?.code || sendMessageError?.detail?.error_code;
          
          // Handle concurrent agent run limit (AGENT_RUN_LIMIT_EXCEEDED)
          if (errorCode === 'AGENT_RUN_LIMIT_EXCEEDED' || (sendMessageError?.status === 402 && errorMessage.includes('concurrent'))) {
            const detail = sendMessageError?.detail || {};
            const runningCount = detail.running_count || 0;
            const limit = detail.limit || 1;
            const message = detail.message || `Maximum of ${limit} concurrent agent run${limit > 1 ? 's' : ''} allowed. You currently have ${runningCount} running.`;
            
            console.log('⚠️ Concurrent agent run limit reached');
            Alert.alert(
              'Concurrent Runs Limit Reached',
              `${message}\n\nPlease stop a running agent or wait for one to complete before starting a new one.`,
              [{ text: 'OK' }]
            );
            return;
          }
          
          // Handle project limit
          if (sendMessageError?.status === 402 && errorCode === 'PROJECT_LIMIT_EXCEEDED') {
            console.log('💳 Project limit exceeded - opening billing modal');
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
      console.error('[useChat] Error sending message:', error);
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
    
    console.log('[useChat] 🛑 Stopping agent run:', runIdToStop, '(local:', agentRunId, ', hook:', currentHookRunId, ')');
    
    // Always clear local state and stop streaming
    setAgentRunId(null);
    await stopStreaming();
    
    if (runIdToStop) {
      try {
        await stopAgentRunMutation.mutateAsync(runIdToStop);
        console.log('[useChat] ✅ Backend stop confirmed');
        
        queryClient.invalidateQueries({ queryKey: chatKeys.activeRuns() });
        
        if (activeThreadId) {
          queryClient.invalidateQueries({ queryKey: chatKeys.messages(activeThreadId) });
          refetchMessages();
        }
      } catch (error) {
        console.error('[useChat] ❌ Error stopping agent:', error);
      }
    } else {
      console.log('[useChat] ⚠️ No run ID to stop, but streaming was stopped');
    }
  }, [agentRunId, currentHookRunId, stopStreaming, stopAgentRunMutation, queryClient, activeThreadId, refetchMessages]);

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
      console.error('Error picking document:', error);
    }
    
    setIsAttachmentDrawerVisible(false);
  }, [addAttachment]);

  const handleQuickAction = useCallback((actionId: string) => {
    console.log('[useChat] 🔄 Switching mode:', selectedQuickAction, '→', actionId);
    
    // Don't do anything if switching to the same mode
    if (actionId === selectedQuickAction) {
      return;
    }
    
    // Save current mode's FULL state before switching (like saving a browser tab)
    if (selectedQuickAction) {
      console.log('[useChat] 💾 Saving full state for mode:', selectedQuickAction, {
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
      console.log('[useChat] ⚡ Instant restore for mode:', actionId, {
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
        console.log('[useChat] 🔌 Reconnecting to stream:', savedState.agentRunId);
        lastStreamStartedRef.current = null; // Allow stream to restart
        startStreaming(savedState.agentRunId);
      }
    } else {
      // No saved state - show fresh thread list for new mode
      console.log('[useChat] 📋 Fresh mode, showing thread list:', actionId);
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
    console.log('[useChat] 📋 Going back to thread list for mode:', selectedQuickAction);
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
    console.log('[useChat] Opening thread from list:', threadId);
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
      console.error('Transcription error:', error);
      Alert.alert(
        t('common.error'),
        t('audio.transcriptionFailed') || 'Failed to transcribe audio'
      );
    } finally {
      setIsTranscribing(false);
    }
  }, [t]);

  const activeThread = useMemo(() => {
    if (!activeThreadId || !threadData) return null;
    
    return {
      id: activeThreadId,
      title: threadData.title,
      messages,
      createdAt: new Date(threadData.created_at),
      updatedAt: new Date(threadData.updated_at),
    };
  }, [activeThreadId, threadData, messages]);

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
    isSendingMessage: sendMessageMutation.isPending || unifiedAgentStartMutation.isPending,
    isAgentRunning: isStreaming,
    
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
