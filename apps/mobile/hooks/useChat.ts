/**
 * Unified Chat Hook
 * 
 * Single source of truth for all chat state and operations.
 * Consolidates:
 * - useChatThread (chat orchestration)
 * - useThreadData (data loading)
 * - useAgentStream (streaming)
 * - useChatInput (input state)
 * - React Query hooks (API calls)
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Alert, Keyboard } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import EventSource from 'react-native-sse';
import { useQueryClient } from '@tanstack/react-query';
import type { UnifiedMessage, ParsedContent, ParsedMetadata, Thread } from '@/api/types';
import { API_URL, getAuthToken } from '@/api/config';
import { safeJsonParse } from '@/lib/utils/message-grouping';
import { useLanguage } from '@/contexts';
import type { ToolMessagePair } from '@/components/chat/MessageRenderer';
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

// ============================================================================
// Types
// ============================================================================

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
  // Thread Management
  activeThread: {
    id: string;
    title?: string;
    messages: UnifiedMessage[];
    createdAt: Date;
    updatedAt: Date;
  } | null;
  threads: Thread[];
  loadThread: (threadId: string) => void;
  startNewChat: () => void;
  updateThreadTitle: (newTitle: string) => Promise<void>;
  hasActiveThread: boolean;
  refreshMessages: () => Promise<void>;
  
  // Messages & Streaming
  messages: UnifiedMessage[];
  streamingContent: string;
  streamingToolCall: ParsedContent | null;
  isStreaming: boolean;
  
  // Message Operations
  sendMessage: (content: string, agentId: string, agentName: string) => Promise<void>;
  stopAgent: () => void;
  
  // Input State
  inputValue: string;
  setInputValue: (value: string) => void;
  attachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (index: number) => void;
  
  // Tool Drawer
  selectedToolData: {
    toolMessages: ToolMessagePair[];
    initialIndex: number;
  } | null;
  setSelectedToolData: (data: { toolMessages: ToolMessagePair[]; initialIndex: number; } | null) => void;
  
  // Loading States
  isLoading: boolean;
  isSendingMessage: boolean;
  isAgentRunning: boolean;
  
  // Attachment Actions
  handleTakePicture: () => Promise<void>;
  handleChooseImages: () => Promise<void>;
  handleChooseFiles: () => Promise<void>;
  
  // Quick Actions
  selectedQuickAction: string | null;
  handleQuickAction: (actionId: string) => void;
  clearQuickAction: () => void;
  getPlaceholder: () => string;
  
  // Attachment Drawer
  isAttachmentDrawerVisible: boolean;
  openAttachmentDrawer: () => void;
  closeAttachmentDrawer: () => void;
  
  // Audio Transcription
  transcribeAndAddToInput: (audioUri: string) => Promise<void>;
  isTranscribing: boolean;
}

// ============================================================================
// Main Hook
// ============================================================================

export function useChat(): UseChatReturn {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  // ============================================================================
  // State - Single Source of Truth
  // ============================================================================

  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingToolCall, setStreamingToolCall] = useState<ParsedContent | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selectedToolData, setSelectedToolData] = useState<{
    toolMessages: ToolMessagePair[];
    initialIndex: number;
  } | null>(null);
  const [isAttachmentDrawerVisible, setIsAttachmentDrawerVisible] = useState(false);
  const [selectedQuickAction, setSelectedQuickAction] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isNewThreadOptimistic, setIsNewThreadOptimistic] = useState(false); // Flag for optimistic new threads

  // ============================================================================
  // React Query Hooks
  // ============================================================================

  const { data: threadsData = [] } = useThreads();

  // Smart data fetching - avoid refetching during streaming
  const shouldFetchThread = !!activeThreadId;
  const shouldFetchMessages = !!activeThreadId;

  const { data: threadData, isLoading: isThreadLoading } = useThread(shouldFetchThread ? activeThreadId : undefined);
  const { data: messagesData, isLoading: isMessagesLoading, refetch: refetchMessages } = useMessages(shouldFetchMessages ? activeThreadId : undefined);
  const { data: activeRuns } = useActiveAgentRuns();

  // Mutations
  const sendMessageMutation = useSendMessageMutation();
  const unifiedAgentStartMutation = useUnifiedAgentStartMutation();
  const stopAgentRunMutation = useStopAgentRunMutation();
  const updateThreadMutation = useUpdateThread();
  const uploadFilesMutation = useUploadMultipleFiles();

  // ============================================================================
  // Streaming - Internal EventSource Management
  // ============================================================================

  const eventSourceRef = useRef<EventSource | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentRunIdRef = useRef<string | null>(null);
  const processedMessageIds = useRef<Set<string>>(new Set());
  const completedRunIds = useRef<Set<string>>(new Set());
  
  const streamingBufferRef = useRef<string>('');
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);
  const isInToolModeRef = useRef<boolean>(false);

  const isStreaming = !!currentRunIdRef.current;

  const flushStreamingBuffer = useCallback(() => {
    if (streamingBufferRef.current && isMountedRef.current) {
      const content = streamingBufferRef.current;
      streamingBufferRef.current = '';
      setStreamingContent((prev) => prev + content);
      lastUpdateTimeRef.current = Date.now();
    }
  }, []);

  const addContentImmediate = useCallback((content: string) => {
    streamingBufferRef.current += content;
    
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTimeRef.current;
    
    if (streamingTimerRef.current) {
      clearTimeout(streamingTimerRef.current);
    }
    
    if (timeSinceLastUpdate >= 16 || streamingBufferRef.current.length >= 5) {
      flushStreamingBuffer();
    } else {
      streamingTimerRef.current = setTimeout(() => {
        flushStreamingBuffer();
      }, 16);
    }
  }, [flushStreamingBuffer]);

  // Helper t o safely update messages array with deduplication
  const updateMessagesWithDeduplication = useCallback((newMessage: UnifiedMessage) => {
    setMessages((prev) => {
      const messageExists = prev.some(
        (m) => m.message_id === newMessage.message_id,
      );
      if (messageExists) {
        return prev.map((m) =>
          m.message_id === newMessage.message_id ? newMessage : m,
        );
      } else {
        if (newMessage.type === 'user') {
          const newContent = safeJsonParse<ParsedContent>(newMessage.content, {});
          const newText = typeof newContent.content === 'string' ? newContent.content : '';
          
          const optimisticIndex = prev.findIndex((m) => {
            if (m.type !== 'user') return false;
            if (!(m.message_id?.startsWith('optimistic-') || m.message_id?.startsWith('temp-'))) return false;
            
            // Parse the optimistic message content
            const optimisticContent = safeJsonParse<ParsedContent>(m.content, {});
            const optimisticText = typeof optimisticContent.content === 'string' ? optimisticContent.content : '';
            
            // Compare actual text content, not JSON strings
            return optimisticText === newText;
          });
          
          if (optimisticIndex !== -1) {
            // Replace the optimistic message with the real one
            return prev.map((m, index) =>
              index === optimisticIndex ? newMessage : m,
            );
          }
        }
        // Add new message
        return [...prev, newMessage];
      }
    });
  }, []);

  // Finalize stream
  const finalizeStream = useCallback(() => {
    if (!isMountedRef.current) return;

    console.log('[useChat] Finalizing stream');
    
    if (streamingTimerRef.current) {
      clearTimeout(streamingTimerRef.current);
      streamingTimerRef.current = null;
    }
    flushStreamingBuffer();
    
    if (currentRunIdRef.current) {
      completedRunIds.current.add(currentRunIdRef.current);
    }
    
    currentRunIdRef.current = null;
    processedMessageIds.current.clear();

    queryClient.invalidateQueries({ queryKey: chatKeys.activeRuns() });
    
    const sandboxId = threadData?.project?.sandbox?.id;
    if (sandboxId) {
      console.log('[useChat] Invalidating file queries for sandbox:', sandboxId);
      queryClient.invalidateQueries({ 
        queryKey: ['files', 'sandbox', sandboxId],
        refetchType: 'all',
      });
    }

    if (isNewThreadOptimistic) {
      console.log('[useChat] Clearing optimistic flag - streaming complete');
      setIsNewThreadOptimistic(false);
    }

    setTimeout(() => {
      if (isMountedRef.current) {
        console.log('[useChat] Clearing streaming state');
        setStreamingContent('');
        setStreamingToolCall(null);
        setAgentRunId(null);
        refetchMessages();
      }
    }, 50);
  }, [refetchMessages, queryClient, isNewThreadOptimistic, flushStreamingBuffer, threadData]);

  const handleStreamMessage = useCallback((rawData: string) => {
    if (!isMountedRef.current) return;

    let processedData = rawData;
    if (processedData.startsWith('data: ')) {
      processedData = processedData.substring(6).trim();
    }
    if (!processedData) return;

    // Check for completion messages
    if (
      processedData === '{"type": "status", "status": "completed", "message": "Agent run completed successfully"}' ||
      processedData.includes('Run data not available for streaming') ||
      processedData.includes('Stream ended with status: completed')
    ) {
      console.log('[useChat] Stream completion detected, closing connection');
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      finalizeStream();
      return;
    }

    // Check for error messages
    try {
      const jsonData = JSON.parse(processedData);
      if (jsonData.status === 'error') {
        console.error('[useChat] Received error status message:', jsonData);
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        finalizeStream();
        return;
      }
    } catch (jsonError) {
      // Not JSON, continue processing
    }

    // Parse JSON message
    const message = safeJsonParse<UnifiedMessage | null>(processedData, null);
    if (!message) {
      console.warn('[useChat] Failed to parse streamed message:', processedData);
      return;
    }

    const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
    const parsedMetadata = safeJsonParse<ParsedMetadata>(message.metadata, {});

    switch (message.type) {
      case 'assistant':
        if (parsedMetadata.stream_status === 'chunk' && parsedContent.content) {
          const content = parsedContent.content;
          
          if (content.includes('<function_calls>')) {
            const beforeFunctionCalls = content.split('<function_calls>')[0];
            
            if (beforeFunctionCalls && !isInToolModeRef.current) {
              addContentImmediate(beforeFunctionCalls);
            }
            
            isInToolModeRef.current = true;
            
            if (!streamingToolCall) {
              setStreamingToolCall({
                role: 'assistant',
                status_type: 'tool_started',
                name: 'Tool',
                function_name: 'Tool',
                arguments: {},
              });
            }
            
            const invokeMatch = content.match(/<invoke name="([^"]+)">/);
            if (invokeMatch) {
              const functionName = invokeMatch[1];
              console.log('[useChat] Extracted function name:', functionName);
              
              setStreamingToolCall({
                role: 'assistant',
                status_type: 'tool_started',
                name: functionName,
                function_name: functionName,
                arguments: {},
              });
            }
          } else if (!isInToolModeRef.current) {
            addContentImmediate(content);
          }
        } else if (parsedMetadata.stream_status === 'complete') {
          if (message.message_id && !processedMessageIds.current.has(message.message_id)) {
            processedMessageIds.current.add(message.message_id);
            
            updateMessagesWithDeduplication(message);
            
            isInToolModeRef.current = false;
            
            setTimeout(() => {
              if (isMountedRef.current) {
                setStreamingContent('');
              }
            }, 50);
          }
        } else if (!parsedMetadata.stream_status) {
          if (message.message_id && !processedMessageIds.current.has(message.message_id)) {
            processedMessageIds.current.add(message.message_id);
            updateMessagesWithDeduplication(message);
          }
        }
        break;

      case 'user':
        // Handle user messages from stream - deduplicate with optimistic messages
        if (message.message_id && !processedMessageIds.current.has(message.message_id)) {
          processedMessageIds.current.add(message.message_id);
          updateMessagesWithDeduplication(message);
        }
        break;

      case 'tool':
        setStreamingToolCall(null);
        isInToolModeRef.current = false;

        if (message.message_id && !processedMessageIds.current.has(message.message_id)) {
          processedMessageIds.current.add(message.message_id);
          updateMessagesWithDeduplication(message);
        }
        break;

      case 'status':
        switch (parsedContent.status_type) {
          case 'tool_started':
            setStreamingToolCall({
              role: 'assistant',
              status_type: 'tool_started',
              name: parsedContent.function_name,
              function_name: parsedContent.function_name,
              arguments: parsedContent.arguments,
            });
            break;

          case 'tool_completed':
            setStreamingToolCall(null);
            break;

          case 'thread_run_end':
            // Don't finalize here - wait for explicit completion
            console.log('[useChat] thread_run_end received');
            break;
        }
        break;
    }
  }, [addContentImmediate, finalizeStream, flushStreamingBuffer, updateMessagesWithDeduplication]);

  // Start streaming
  const startStreaming = useCallback(async (runId: string) => {
    if (!isMountedRef.current) {
      console.log('[useChat] Not mounted, skipping stream connection');
      return;
    }

    // Prevent duplicate streams
    if (currentRunIdRef.current === runId) {
      console.log('[useChat] Already streaming this run:', runId);
      return;
    }

    // Close any existing stream
    if (eventSourceRef.current) {
      console.log('[useChat] Closing existing stream before starting new one');
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    console.log('[useChat] 🚀 Starting stream for run:', runId);
    
    if (streamingTimerRef.current) {
      clearTimeout(streamingTimerRef.current);
      streamingTimerRef.current = null;
    }
    streamingBufferRef.current = '';
    lastUpdateTimeRef.current = Date.now();
    isInToolModeRef.current = false;
    
    setStreamingContent('');
    setStreamingToolCall(null);
    processedMessageIds.current.clear();
    currentRunIdRef.current = runId;

    try {
      const token = await getAuthToken();
      const url = `${API_URL}/agent-run/${runId}/stream`;

      const eventSource = new EventSource(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        pollingInterval: 0, // Disable reconnection
      });

      eventSourceRef.current = eventSource;

      eventSource.addEventListener('open', () => {
        console.log('[useChat] ✅ Stream connected');
      });

      eventSource.addEventListener('message', (event: any) => {
        if (event.data) {
          handleStreamMessage(event.data);
        }
      });

      eventSource.addEventListener('error', (error: any) => {
        console.error('[useChat] ❌ Stream error:', error);
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        finalizeStream();
      });
    } catch (error) {
      console.error('[useChat] Failed to start stream:', error);
      currentRunIdRef.current = null;
      finalizeStream();
    }
  }, [handleStreamMessage, finalizeStream]);

  // Stop streaming
  const stopStreaming = useCallback(() => {
    console.log('[useChat] Stopping stream');
    
    if (streamingTimerRef.current) {
      clearTimeout(streamingTimerRef.current);
      streamingTimerRef.current = null;
    }
    streamingBufferRef.current = '';
    isInToolModeRef.current = false;
    
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    currentRunIdRef.current = null;
    setStreamingContent('');
    setStreamingToolCall(null);
    processedMessageIds.current.clear();
  }, []);

  // ============================================================================
  // Effects - Thread Management & Auto-Connect
  // ============================================================================

  // Set mounted state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Thread change cleanup
  const prevThreadIdRef = useRef<string | undefined>(undefined);
  
  useEffect(() => {
    // Only cleanup if thread actually changed (not on initial load or same thread)
    if (prevThreadIdRef.current && prevThreadIdRef.current !== activeThreadId) {
      console.log('[useChat] Thread switched');
      
      // ✨ Clear messages immediately when switching threads
      setMessages([]);
      
      // Clear streaming state
      setStreamingContent('');
      setStreamingToolCall(null);
      
      // Close any active stream
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        currentRunIdRef.current = null;
      }
    }
    
    // Update the previous thread ID
    prevThreadIdRef.current = activeThreadId;

    // Load messages for thread - simple approach since we clear on thread switch
    if (messagesData && !isNewThreadOptimistic && !isStreaming) {
      const unifiedMessages = messagesData as unknown as UnifiedMessage[];
      
      // Simple merge: Don't keep any optimistic messages, just use server data
      setMessages(unifiedMessages);
      
      console.log('🔄 [useChat] Loaded messages for thread:', {
        messageCount: unifiedMessages.length,
        currentThreadId: activeThreadId
      });
    }

    // Check for active agent run
    const activeRun = activeRuns?.find(r => r.thread_id === activeThreadId);
    if (activeRun?.status === 'running' && !completedRunIds.current.has(activeRun.id)) {
      console.log('[useChat] Found active agent run:', activeRun.id);
      setAgentRunId(activeRun.id);
    } else if (agentRunId && !activeRun && !isStreaming) {
      console.log('[useChat] No active agent run and not streaming, clearing agentRunId');
      setAgentRunId(null);
    }
  }, [activeThreadId, messagesData, activeRuns, agentRunId, isNewThreadOptimistic]);

  useEffect(() => {
    if (agentRunId && activeThreadId && !currentRunIdRef.current) {
      console.log('[useChat] Auto-connecting to stream:', agentRunId);
      startStreaming(agentRunId);
    } else if (!agentRunId && currentRunIdRef.current) {
      console.log('[useChat] No agentRunId but stream active, stopping');
      stopStreaming();
    }
  }, [agentRunId, activeThreadId, startStreaming, stopStreaming]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (activeThreadId) {
      console.log('📊 [useChat] Loading state:', {
        isLoading: (isThreadLoading || isMessagesLoading) && !!activeThreadId && !isNewThreadOptimistic && messages.length === 0,
        isThreadLoading,
        isMessagesLoading,
        isNewThreadOptimistic,
        messagesCount: messages.length,
        threadId: activeThreadId,
      });
    }
  }, [isThreadLoading, isMessagesLoading, activeThreadId, isNewThreadOptimistic, messages.length]);

  // ============================================================================
  // Public API - Thread Operations
  // ============================================================================

  const refreshMessages = useCallback(async () => {
    if (!activeThreadId || isStreaming) {
      console.log('[useChat] Cannot refresh: no active thread or streaming in progress');
      return;
    }
    
    console.log('[useChat] 🔄 Refreshing messages for thread:', activeThreadId);
    
    try {
      // Refetch messages from server
      await refetchMessages();
      
      // Also invalidate queries to ensure fresh data
      queryClient.invalidateQueries({ 
        queryKey: chatKeys.messages(activeThreadId) 
      });
      
      // If there's a sandbox, refresh file list too
      const sandboxId = threadData?.project?.sandbox?.id;
      if (sandboxId) {
        queryClient.invalidateQueries({ 
          queryKey: ['files', 'sandbox', sandboxId],
          refetchType: 'all',
        });
      }
      
      console.log('[useChat] ✅ Messages refreshed successfully');
    } catch (error) {
      console.error('[useChat] ❌ Failed to refresh messages:', error);
      throw error;
    }
  }, [activeThreadId, isStreaming, refetchMessages, queryClient, threadData]);

  const loadThread = useCallback((threadId: string) => {
    console.log('[useChat] Loading thread:', threadId);
    console.log('🔄 [useChat] Thread loading initiated');
    
    // Clear agent run ID first to prevent race condition
    setAgentRunId(null);
    
    // Stop any active streaming
    stopStreaming();
    
    // Clear completed runs tracking for fresh state
    completedRunIds.current.clear();
    processedMessageIds.current.clear(); // Clear processed message tracking
    
    // Clear UI state
    setSelectedToolData(null);
    setInputValue('');
    setAttachments([]);
    setIsNewThreadOptimistic(false); // Clear optimistic flag when loading existing thread
    
    // Clear messages to ensure clean thread switch
    setMessages([]);
    
    // Set new thread
    setActiveThreadId(threadId);
  }, [stopStreaming]);

  const startNewChat = useCallback(() => {
    console.log('[useChat] Starting new chat');
    setActiveThreadId(undefined);
    setAgentRunId(null);
    setMessages([]);
    setInputValue('');
    setAttachments([]);
    setSelectedToolData(null);
    setIsNewThreadOptimistic(false);
    completedRunIds.current.clear();
    processedMessageIds.current.clear();
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
      console.log('[useChat] Sending message:', { content, agentId, agentName, activeThreadId, attachmentsCount: attachments.length });
      
      // Validate file sizes
      for (const attachment of attachments) {
        const validation = validateFileSize(attachment.size);
        if (!validation.valid) {
          Alert.alert(t('common.error'), validation.error || t('attachments.fileTooLarge'));
          return;
        }
      }
      
      let currentThreadId = activeThreadId;
      
      if (!currentThreadId) {
        // ========================================================================
        // NEW THREAD: Use /agent/start with FormData
        // ========================================================================
        console.log('[useChat] Creating new thread via /agent/start with optimistic UI');
        
        // ✨ INSTANT UI: Show user message immediately like ChatGPT
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
        
        // Convert attachments to FormData-compatible format
        const formDataFiles = attachments.length > 0
          ? await convertAttachmentsToFormDataFiles(attachments)
          : [];
        
        console.log('[useChat] Converted', formDataFiles.length, 'attachments for FormData');
        
        const createResult = await unifiedAgentStartMutation.mutateAsync({
          // No threadId = create new thread
          prompt: content,
          agentId: agentId,
          modelName: 'claude-sonnet-4',
          files: formDataFiles as any, // FormData files for new thread
        });
        
        currentThreadId = createResult.thread_id;
        console.log('[useChat] Thread created:', currentThreadId, 'Agent Run:', createResult.agent_run_id);
        
        // Set thread ID and start streaming immediately like ChatGPT
        setActiveThreadId(currentThreadId);
        
        if (createResult.agent_run_id) {
          console.log('[useChat] Starting INSTANT streaming:', createResult.agent_run_id);
          setAgentRunId(createResult.agent_run_id);
          // Start streaming immediately - no delays
          startStreaming(createResult.agent_run_id);
        }
        
        // Clear input and attachments AFTER successful send
        setInputValue('');
        setAttachments([]);
      } else {
        // ========================================================================
        // EXISTING THREAD: Upload files to sandbox, then send message with references
        // ========================================================================
        console.log('[useChat] Sending to existing thread:', currentThreadId);
        
        // ✨ INSTANT UI: Show user message immediately like ChatGPT (same as new threads)
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
        
        // Add optimistic message to existing messages
        setMessages((prev) => [...prev, optimisticUserMessage]);
        console.log('✨ [useChat] INSTANT user message display for existing thread');
        
        // Set optimistic flag for existing threads too (for consistent behavior)
        setIsNewThreadOptimistic(true);
        
        let messageContent = content;
        
        // Upload files to sandbox if there are attachments
        if (attachments.length > 0) {
          // Get sandbox ID from thread data
          const sandboxId = threadData?.project?.sandbox?.id;
          
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
            // Convert attachments to upload format
            const filesToUpload = await convertAttachmentsToFormDataFiles(attachments);
            
            // Upload files to sandbox (simplified - no progress tracking for now)
            const uploadResults = await uploadFilesMutation.mutateAsync({
              sandboxId,
              files: filesToUpload.map(f => ({
                uri: f.uri,
                name: f.name,
                type: f.type,
              })),
            });
            
            console.log('[useChat] Files uploaded successfully:', uploadResults.length);
            
            // Generate file references
            const filePaths = uploadResults.map(result => result.path);
            const fileReferences = generateFileReferences(filePaths);
            
            // Append file references to message
            messageContent = content
              ? `${content}\n\n${fileReferences}`
              : fileReferences;
              
            console.log('[useChat] Message with file references prepared');
          } catch (uploadError) {
            console.error('[useChat] File upload failed:', uploadError);
            
            Alert.alert(
              t('common.error'),
              t('attachments.uploadFailed') || 'Failed to upload files'
            );
            return; // Don't send message if upload failed
          }
        }
        
        // Send message with file references (if any)
        const result = await sendMessageMutation.mutateAsync({
          threadId: currentThreadId,
          message: messageContent,
          modelName: 'claude-sonnet-4',
        });
        
        console.log('[useChat] Message sent, agent run started:', result.agentRunId);
        
        // Set agent run ID and start streaming immediately like ChatGPT
        if (result.agentRunId) {
          console.log('[useChat] Starting INSTANT streaming for existing thread:', result.agentRunId);
          setAgentRunId(result.agentRunId);
          // Start streaming immediately - no delays
          startStreaming(result.agentRunId);
        }
        
        // Clear optimistic flag after successful send
        setIsNewThreadOptimistic(false);
        
        // Clear input and attachments AFTER successful send
        setInputValue('');
        setAttachments([]);
      }
    } catch (error) {
      console.error('[useChat] Error sending message:', error);
      throw error;
    }
  }, [
    activeThreadId,
    attachments,
    sendMessageMutation,
    unifiedAgentStartMutation,
    uploadFilesMutation,
    threadData,
    t,
    startStreaming,
  ]);

  const stopAgent = useCallback(() => {
    if (agentRunId) {
      console.log('[useChat] 🛑 Stopping agent run:', agentRunId);
      
      const runIdToStop = agentRunId;
      
      // ✨ IMMEDIATE UI FEEDBACK - Clear all state first
      console.log('[useChat] ⚡ Clearing UI state immediately');
      
      // 1. Mark run as completed to prevent reconnection
      completedRunIds.current.add(runIdToStop);
      
      // 2. Clear agent run ID
      setAgentRunId(null);
      
      // 3. Stop streaming and close connection
      stopStreaming();
      
      // 4. Clear streaming content immediately
      setStreamingContent('');
      setStreamingToolCall(null);
      
      console.log('[useChat] ✅ UI cleared immediately');
      
      // Make API call to stop on backend (async, but UI is already stopped)
      stopAgentRunMutation.mutate(runIdToStop, {
        onSuccess: () => {
          console.log('[useChat] ✅ Backend stop confirmed');
          // Invalidate queries to ensure fresh state
          queryClient.invalidateQueries({ queryKey: chatKeys.activeRuns() });
          if (activeThreadId) {
            queryClient.invalidateQueries({ queryKey: chatKeys.messages(activeThreadId) });
          }
        },
        onError: (error) => {
          console.error('[useChat] ❌ Backend stop failed:', error);
          // UI is already stopped, so this is just a warning
        }
      });
    }
  }, [agentRunId, stopAgentRunMutation, stopStreaming, queryClient, activeThreadId]);

  // ============================================================================
  // Public API - Attachment Operations
  // ============================================================================

  const handleTakePicture = useCallback(async () => {
    console.log('[useChat] Take picture');
    
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      
      if (status !== 'granted') {
        console.log('[useChat] Camera permission denied');
        Alert.alert(
          t('attachments.cameraPermissionRequired'),
          t('attachments.cameraPermissionMessage'),
          [{ text: t('common.ok') }]
        );
        return;
      }

      console.log('[useChat] Opening camera');
      
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        console.log('[useChat] Picture taken:', asset.uri);

        const newAttachment: Attachment = {
          type: 'image',
          uri: asset.uri,
          mimeType: asset.type,
        };
        
        setAttachments(prev => [...prev, newAttachment]);
      }
    } catch (error) {
      console.error('[useChat] Camera error:', error);
      Alert.alert(t('common.error'), t('attachments.failedToOpenCamera'));
    }
  }, [t, attachments]);

  const handleChooseImages = useCallback(async () => {
    console.log('[useChat] Choose images');
    
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      
      if (status !== 'granted') {
        console.log('[useChat] Media library permission denied');
        Alert.alert(
          t('attachments.photosPermissionRequired'),
          t('attachments.photosPermissionMessage'),
          [{ text: t('common.ok') }]
        );
        return;
      }

      console.log('[useChat] Opening image picker');
      
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        console.log('[useChat] Selected', result.assets.length, 'items');
        
        const newAttachments: Attachment[] = result.assets.map((asset) => ({
          type: asset.type === 'video' ? 'video' : 'image',
          uri: asset.uri,
          mimeType: asset.type,
        }));
        
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (error) {
      console.error('[useChat] Image picker error:', error);
      Alert.alert(t('common.error'), t('attachments.failedToOpenImagePicker'));
    }
  }, [t, attachments]);

  const handleChooseFiles = useCallback(async () => {
    console.log('[useChat] Choose files');
    
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: true,
      });

      if (result.canceled) {
        console.log('[useChat] Document picker canceled');
        return;
      }

      if (result.assets && result.assets.length > 0) {
        console.log('[useChat] Selected', result.assets.length, 'files');
        
        const newAttachments: Attachment[] = result.assets.map((asset) => ({
          type: 'document',
          uri: asset.uri,
          name: asset.name,
          size: asset.size,
          mimeType: asset.mimeType,
        }));
        
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (error) {
      console.error('[useChat] Document picker error:', error);
      Alert.alert(t('common.error'), t('attachments.failedToOpenFilePicker'));
    }
  }, [t, attachments]);

  const removeAttachment = useCallback((index: number) => {
    console.log('[useChat] Removing attachment at index:', index);
    setAttachments(prev => prev.filter((_, i) => i !== index));
  }, []);

  const addAttachment = useCallback((attachment: Attachment) => {
    console.log('[useChat] Adding attachment:', attachment);
    setAttachments(prev => [...prev, attachment]);
  }, []);

  // ============================================================================
  // Public API - Quick Actions
  // ============================================================================

  const handleQuickAction = useCallback((actionId: string) => {
    console.log('[useChat] Quick action:', actionId);
    
    if (selectedQuickAction === actionId) {
      setSelectedQuickAction(null);
    } else {
      setSelectedQuickAction(actionId);
    }
  }, [selectedQuickAction]);

  const clearQuickAction = useCallback(() => {
    console.log('[useChat] Clearing quick action');
    setSelectedQuickAction(null);
  }, []);

  const getPlaceholder = useCallback(() => {
    if (!selectedQuickAction) return t('placeholders.default');
    
    switch (selectedQuickAction) {
      case 'image':
        return t('placeholders.imageGeneration');
      case 'slides':
        return t('placeholders.slidesGeneration');
      case 'data':
        return t('placeholders.dataAnalysis');
      case 'docs':
        return t('placeholders.documentCreation');
      case 'people':
        return t('placeholders.peopleSearch');
      case 'research':
        return t('placeholders.researchQuery');
      default:
        return t('placeholders.default');
    }
  }, [selectedQuickAction, t]);

  // ============================================================================
  // Public API - Attachment Drawer
  // ============================================================================

  const openAttachmentDrawer = useCallback(() => {
    console.log('[useChat] Opening attachment drawer');
    Keyboard.dismiss(); // Dismiss keyboard to prevent interference
    setIsAttachmentDrawerVisible(true);
  }, []);

  const closeAttachmentDrawer = useCallback(() => {
    console.log('[useChat] Closing attachment drawer');
    setIsAttachmentDrawerVisible(false);
  }, []);

  // ============================================================================
  // Public API - Audio Transcription
  // ============================================================================

  const transcribeAndAddToInput = useCallback(async (audioUri: string) => {
    console.log('[useChat] Transcribing audio:', audioUri);
    
    // Validate audio file
    const validation = validateAudioFile(audioUri);
    if (!validation.valid) {
      console.error('[useChat] Invalid audio file:', validation.error);
      Alert.alert(t('common.error'), validation.error || 'Invalid audio file');
      return;
    }
    
    setIsTranscribing(true);
    
    try {
      // Transcribe audio
      const transcribedText = await transcribeAudio(audioUri);
      console.log('[useChat] Transcription complete:', transcribedText);
      
      // Add transcribed text to input
      // If there's already text, add a space before appending
      setInputValue(prev => {
        const newValue = prev ? `${prev} ${transcribedText}` : transcribedText;
        console.log('[useChat] Updated input value with transcription');
        return newValue;
      });
      
      // Show success feedback
      console.log('✅ Transcription added to input');
    } catch (error) {
      console.error('[useChat] Transcription failed:', error);
      Alert.alert(
        t('common.error'),
        error instanceof Error ? error.message : 'Failed to transcribe audio'
      );
    } finally {
      setIsTranscribing(false);
    }
  }, [t]);

  // ============================================================================
  // Computed State
  // ============================================================================

  const activeThread = useMemo(() => {
    if (!threadData) return null;
    return {
      id: threadData.thread_id,
      title: threadData.project?.name || threadData.title || 'New Chat',
      messages: messages,
      createdAt: new Date(threadData.created_at),
      updatedAt: new Date(threadData.updated_at),
    };
  }, [threadData, messages]);

  // ✨ Agent running state - combines agentRunId, streaming, and currentRunIdRef
  // Note: Don't include sendMessageMutation/unifiedAgentStartMutation.isPending here
  // as those are for initial send, not for ongoing agent execution
  const isAgentRunning = !!agentRunId || isStreaming || !!currentRunIdRef.current;
  
  // Debug running state
  useEffect(() => {
    console.log('🔍 [useChat] Running state check:', {
      agentRunId: !!agentRunId,
      isStreaming,
      currentRunId: !!currentRunIdRef.current,
      isAgentRunning
    });
  }, [agentRunId, isStreaming, isAgentRunning]);
  
  // Check if any attachments are currently uploading
  const hasUploadingAttachments = attachments.some(a => a.isUploading);
  
  // Don't disable input during upload - only during message send/agent run
  const isSendingMessage = sendMessageMutation.isPending || unifiedAgentStartMutation.isPending;
  
  // Compute isLoading: true when thread data or messages are being fetched
  // ✨ BUT: Never show loading when we have messages (optimistic or real) - they should appear instantly
  // ✨ AND: Never show loading for new optimistic threads - they should appear instantly
  const isLoading = (isThreadLoading || isMessagesLoading) && !!activeThreadId && !isNewThreadOptimistic && messages.length === 0;

  // ============================================================================
  // Return Public API
  // ============================================================================

  return {
    // Thread Management
    activeThread,
    threads: threadsData,
    loadThread,
    startNewChat,
    updateThreadTitle,
    hasActiveThread: !!activeThreadId,
    refreshMessages,
    
    // Messages & Streaming
    messages,
    streamingContent,
    streamingToolCall,
    isStreaming,
    
    // Message Operations
    sendMessage,
    stopAgent,
    
    // Input State
    inputValue,
    setInputValue,
    attachments,
    addAttachment,
    removeAttachment,
    
    // Tool Drawer
    selectedToolData,
    setSelectedToolData,
    
    // Loading States
    isLoading,
    isSendingMessage,
    isAgentRunning,
    
    // Attachment Actions
    handleTakePicture,
    handleChooseImages,
    handleChooseFiles,
    
    // Quick Actions
    selectedQuickAction,
    handleQuickAction,
    clearQuickAction,
    getPlaceholder,
    
    // Attachment Drawer
    isAttachmentDrawerVisible,
    openAttachmentDrawer,
    closeAttachmentDrawer,
    
    // Audio Transcription
    transcribeAndAddToInput,
    isTranscribing,
  };
}

