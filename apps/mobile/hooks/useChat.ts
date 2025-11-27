import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Alert, Keyboard } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
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
import { useAgentStream } from './useAgentStream';
import { useAgent } from '@/contexts/AgentContext';
import { useAvailableModels } from '@/lib/models';
import { useBillingContext } from '@/contexts/BillingContext';
import { usePricingModalStore } from '@/stores/billing-modal-store';

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
  const [selectedQuickAction, setSelectedQuickAction] = useState<string | null>(null);
  const [selectedQuickActionOption, setSelectedQuickActionOption] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isNewThreadOptimistic, setIsNewThreadOptimistic] = useState(false);
  const [activeSandboxId, setActiveSandboxId] = useState<string | undefined>(undefined);
  const [userInitiatedRun, setUserInitiatedRun] = useState(false);

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
    
    console.log('🔍 [useChat] Accessible models:', {
      total: availableModels.length,
      accessible: filtered.length,
      hasActiveSubscription,
      modelIds: filtered.map(m => m.id),
    });
    
    return filtered;
  }, [availableModels, hasActiveSubscription]);

  // Auto-select model when models first load and none is selected
  useEffect(() => {
    // Skip if still loading or no accessible models
    if (modelsLoading || accessibleModels.length === 0) {
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
  }, [selectedModelId, accessibleModels, selectModel, modelsLoading]);
  
  // Determine current model to use
  const currentModel = useMemo(() => {
    // If models are still loading, return undefined
    if (modelsLoading) {
      return undefined;
    }

    // Log model selection state
    console.log('🔍 [useChat] Model selection:', {
      selectedModelId,
      hasActiveSubscription,
      totalModels: availableModels.length,
      accessibleModels: accessibleModels.length,
      accessibleModelIds: accessibleModels.map(m => m.id),
      modelsLoading,
      modelsError: modelsError?.message,
    });
    
    // If a model is selected and accessible, use it
    if (selectedModelId) {
      const model = accessibleModels.find(m => m.id === selectedModelId);
      if (model) {
        console.log('✅ [useChat] Using selected accessible model:', model.id);
        return model.id;
      }
      console.warn('⚠️ [useChat] Selected model not accessible:', selectedModelId);
    }
    
    // Fallback to recommended model or first accessible model
    const recommendedModel = accessibleModels.find(m => m.recommended);
    const firstAccessibleModel = accessibleModels[0];
    const fallbackModel = recommendedModel?.id || firstAccessibleModel?.id;
    
    if (fallbackModel) {
      console.log('✅ [useChat] Using fallback model:', fallbackModel, {
        recommended: recommendedModel?.id,
        firstAccessible: firstAccessibleModel?.id,
      });
    } else {
      console.warn('⚠️ [useChat] No accessible models available');
    }
    
    return fallbackModel;
  }, [selectedModelId, accessibleModels, hasActiveSubscription, availableModels.length, modelsLoading, modelsError]);
  
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
            const optimisticIndex = prev.findIndex(
              (m) =>
                m.type === 'user' &&
                m.message_id?.startsWith('optimistic-') &&
                m.content === message.content,
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
          
          const localExtras = (prev || []).filter(
            (m) =>
              !m.message_id ||
              (typeof m.message_id === 'string' && m.message_id.startsWith('optimistic-')) ||
              !serverIds.has(m.message_id as string),
          );
          
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
      setAgentRunId(null);
      lastStreamStartedRef.current = null;
      
      if (streamHookStatus === 'completed' && activeThreadId) {
        console.log('[useChat] Streaming completed, refetching in background');
        setIsNewThreadOptimistic(false);
        
        queryClient.invalidateQueries({ 
          queryKey: chatKeys.messages(activeThreadId),
        });
      }
    }
  }, [streamHookStatus, setAgentRunId, activeThreadId, queryClient]);

  // Check for running agents when thread becomes active or app comes to foreground
  useEffect(() => {
    if (!activeThreadId || !activeRuns) {
      return;
    }

    // If we don't have an agentRunId set but there's an active run for this thread, resume it
    const runningAgentForThread = activeRuns.find(
      run => run.thread_id === activeThreadId && run.status === 'running'
    );

    if (runningAgentForThread && !agentRunId && !lastStreamStartedRef.current) {
      console.log('🔄 [useChat] Detected active run for current thread, resuming:', runningAgentForThread.id);
      setAgentRunId(runningAgentForThread.id);
    }
  }, [activeThreadId, activeRuns, agentRunId]);

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
  }, [stopStreaming, refetchActiveRuns]);

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
        
        const optimisticUserMessage: UnifiedMessage = {
          message_id: 'optimistic-user-' + Date.now(),
          thread_id: 'optimistic',
          type: 'user',
          content: JSON.stringify({ content }),
          metadata: JSON.stringify({}),
          is_llm_message: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setMessages([optimisticUserMessage]);
        setIsNewThreadOptimistic(true);
        console.log('✨ [useChat] INSTANT user message display');
        
        const formDataFiles = attachments.length > 0
          ? await convertAttachmentsToFormDataFiles(attachments)
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
          
          usePricingModalStore.getState().openPricingModal({
            alertTitle: hasActiveSubscription 
              ? 'No models are currently available. Please try again later or contact support.'
              : 'Upgrade to access AI models'
          });
          return;
        }
        
        console.log('🚀 [useChat] Starting agent with accessible model:', currentModel);
        
        try {
          const createResult = await unifiedAgentStartMutation.mutateAsync({
            prompt: messageWithContext,
            agentId: agentId,
            modelName: currentModel,
            files: formDataFiles as any,
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
          
          setInputValue('');
          setAttachments([]);
        } catch (agentStartError: any) {
          console.error('[useChat] Error starting agent for new thread:', agentStartError);
          
          const errorMessage = agentStartError?.message || '';
          if (errorMessage.includes('402') && errorMessage.includes('PROJECT_LIMIT_EXCEEDED')) {
            console.log('💳 Project limit exceeded - opening billing modal');
            usePricingModalStore.getState().openPricingModal({
              alertTitle: 'Project limit exceeded',
              creditsExhausted: true
            });
            return;
          }
          
          throw agentStartError;
        }
      } else {
        console.log('[useChat] Sending to existing thread:', currentThreadId);
        
        const optimisticUserMessage: UnifiedMessage = {
          message_id: 'optimistic-user-' + Date.now(),
          thread_id: currentThreadId,
          type: 'user',
          content: JSON.stringify({ content }),
          metadata: JSON.stringify({}),
          is_llm_message: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        
        setMessages((prev) => [...prev, optimisticUserMessage]);
        console.log('✨ [useChat] INSTANT user message display for existing thread');
        
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
        
        if (attachments.length > 0) {
          const sandboxId = activeSandboxId;
          
          if (!sandboxId) {
            console.error('[useChat] No sandbox ID available for file upload');
            Alert.alert(
              t('common.error'),
              'Cannot upload files: sandbox not available'
            );
            return;
          }
          
          console.log('[useChat] Uploading', attachments.length, 'files to sandbox:', sandboxId);
          
          try {
            const filesToUpload = await convertAttachmentsToFormDataFiles(attachments);
            
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
          
          usePricingModalStore.getState().openPricingModal({
            alertTitle: hasActiveSubscription 
              ? 'No models are currently available. Please try again later or contact support.'
              : 'Upgrade to access AI models'
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
          
          if (result.agentRunId) {
            console.log('[useChat] Starting INSTANT streaming for existing thread:', result.agentRunId);
            setUserInitiatedRun(true);
            setAgentRunId(result.agentRunId);
          }
          
          setIsNewThreadOptimistic(false);
          
          setInputValue('');
          setAttachments([]);
        } catch (sendMessageError: any) {
          console.error('[useChat] Error sending message to existing thread:', sendMessageError);
          
          const errorMessage = sendMessageError?.message || '';
          if (errorMessage.includes('402') && errorMessage.includes('PROJECT_LIMIT_EXCEEDED')) {
            console.log('💳 Project limit exceeded - opening billing modal');
            usePricingModalStore.getState().openPricingModal({
              alertTitle: 'Project limit exceeded',
              creditsExhausted: true
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
    if (agentRunId) {
      console.log('[useChat] 🛑 Stopping agent run:', agentRunId);
      
      const runIdToStop = agentRunId;
      
      setAgentRunId(null);
      
      await stopStreaming();
      
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
    }
  }, [agentRunId, stopStreaming, stopAgentRunMutation, queryClient, activeThreadId, refetchMessages]);

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
    setSelectedQuickAction(actionId);
    // Reset selected option when changing quick action
    setSelectedQuickActionOption(null);
  }, []);

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
    
    isAttachmentDrawerVisible,
    openAttachmentDrawer,
    closeAttachmentDrawer,
    
    transcribeAndAddToInput,
    isTranscribing,
  };
}
