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
import { Alert } from 'react-native';
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
  useInitiateAgent as useInitiateAgentMutation,
  useStopAgentRun as useStopAgentRunMutation,
  useActiveAgentRuns,
  chatKeys,
} from '@/lib/chat';

// ============================================================================
// Types
// ============================================================================

export interface Attachment {
  type: 'image' | 'video' | 'document';
  uri: string;
  name?: string;
  size?: number;
  mimeType?: string;
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
  hasActiveThread: boolean;
  
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

  // ============================================================================
  // React Query Hooks
  // ============================================================================

  const { data: threadsData = [] } = useThreads();
  const { data: threadData, isLoading: isThreadLoading } = useThread(activeThreadId);
  const { data: messagesData, isLoading: isMessagesLoading, refetch: refetchMessages } = useMessages(activeThreadId);
  const { data: activeRuns } = useActiveAgentRuns();

  // Mutations
  const sendMessageMutation = useSendMessageMutation();
  const initiateAgentMutation = useInitiateAgentMutation();
  const stopAgentRunMutation = useStopAgentRunMutation();

  // ============================================================================
  // Streaming - Internal EventSource Management
  // ============================================================================

  const eventSourceRef = useRef<EventSource | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentRunIdRef = useRef<string | null>(null);
  const processedMessageIds = useRef<Set<string>>(new Set());
  const completedRunIds = useRef<Set<string>>(new Set()); // Track completed runs

  // Computed streaming state
  const isStreaming = !!currentRunIdRef.current;

  // Update streaming status
  const addContentImmediate = useCallback((content: string) => {
    setStreamingContent((prev) => prev + content);
  }, []);

  // Finalize stream
  const finalizeStream = useCallback(() => {
    if (!isMountedRef.current) return;

    console.log('[useChat] Finalizing stream');
    
    // Mark this run as completed to prevent reconnection
    if (currentRunIdRef.current) {
      completedRunIds.current.add(currentRunIdRef.current);
    }
    
    // Clear the current run ID to prevent re-connections
    currentRunIdRef.current = null;
    setAgentRunId(null);

    // Reset streaming state
    setStreamingContent('');
    setStreamingToolCall(null);
    processedMessageIds.current.clear();

    // Refetch messages to get the final state
    refetchMessages();
  }, [refetchMessages]);

  // Handle incoming stream messages
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
          // Check if this chunk contains function_calls XML
          const content = parsedContent.content;
          
          // Detect <function_calls> start
          if (content.includes('<function_calls>')) {
            console.log('[useChat] Detected <function_calls> in stream');
            // Clear streaming text content
            setStreamingContent('');
            
            // Try to extract function name from <invoke name="...">
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
            } else {
              // Show generic loading if we can't extract name yet
              setStreamingToolCall({
                role: 'assistant',
                status_type: 'tool_started',
                name: 'Tool',
                function_name: 'Tool',
                arguments: {},
              });
            }
          } else if (!streamingToolCall) {
            // Only render text if we're not in tool call mode
            addContentImmediate(content);
          }
        } else if (parsedMetadata.stream_status === 'complete') {
          // Clear streaming content as complete message will be added to history
          setStreamingContent('');
          setStreamingToolCall(null);

          // Only emit if has message_id and not already processed
          if (message.message_id && !processedMessageIds.current.has(message.message_id)) {
            processedMessageIds.current.add(message.message_id);
            // Add to messages immediately
            setMessages((prev) => [...prev, message]);
          }
        } else if (!parsedMetadata.stream_status) {
          // Handle non-chunked assistant messages
          if (message.message_id && !processedMessageIds.current.has(message.message_id)) {
            processedMessageIds.current.add(message.message_id);
            setMessages((prev) => [...prev, message]);
          }
        }
        break;

      case 'tool':
        setStreamingToolCall(null); // Clear any streaming tool call

        // Only emit if has message_id and not already processed
        if (message.message_id && !processedMessageIds.current.has(message.message_id)) {
          processedMessageIds.current.add(message.message_id);
          setMessages((prev) => [...prev, message]);
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
  }, [addContentImmediate, finalizeStream, streamingToolCall]);

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

    console.log('[useChat] Starting stream for run:', runId);
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

    // Load messages for thread
    if (messagesData) {
      setMessages(messagesData as unknown as UnifiedMessage[]);
    }

    // Check for active agent run
    const activeRun = activeRuns?.find(r => r.thread_id === activeThreadId);
    if (activeRun?.status === 'running' && !completedRunIds.current.has(activeRun.id)) {
      console.log('[useChat] Found active agent run:', activeRun.id);
      setAgentRunId(activeRun.id);
    }
  }, [activeThreadId, messagesData, activeRuns]);

  // Auto-connect to stream
  useEffect(() => {
    if (agentRunId && activeThreadId && !currentRunIdRef.current) {
      console.log('[useChat] Auto-connecting to stream:', agentRunId);
      startStreaming(agentRunId);
    } else if (!agentRunId && currentRunIdRef.current) {
      console.log('[useChat] No agentRunId but stream active, stopping');
      stopStreaming();
    }
  }, [agentRunId, activeThreadId, startStreaming, stopStreaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  // Log loading state changes
  useEffect(() => {
    if (activeThreadId) {
      console.log('📊 [useChat] Loading state:', {
        isLoading: (isThreadLoading || isMessagesLoading),
        isThreadLoading,
        isMessagesLoading,
        threadId: activeThreadId,
      });
    }
  }, [isThreadLoading, isMessagesLoading, activeThreadId]);

  // ============================================================================
  // Public API - Thread Operations
  // ============================================================================

  const loadThread = useCallback((threadId: string) => {
    console.log('[useChat] Loading thread:', threadId);
    console.log('🔄 [useChat] Thread loading initiated');
    
    // Clear agent run ID first to prevent race condition
    setAgentRunId(null);
    
    // Stop any active streaming
    stopStreaming();
    
    // Clear completed runs tracking for fresh state
    completedRunIds.current.clear();
    
    // Clear UI state
    setSelectedToolData(null);
    setInputValue('');
    setAttachments([]);
    
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
    completedRunIds.current.clear();
    stopStreaming();
  }, [stopStreaming]);

  const sendMessage = useCallback(async (content: string, agentId: string, agentName: string) => {
    if (!content.trim()) return;

    try {
      console.log('[useChat] Sending message:', { content, agentId, agentName, activeThreadId });
      
      let currentThreadId = activeThreadId;
      
      if (!currentThreadId) {
        // NEW THREAD: Use /agent/initiate
        console.log('[useChat] Creating new thread via /agent/initiate');
        const createResult = await initiateAgentMutation.mutateAsync({
          prompt: content,
          agent_id: agentId,
          model_name: 'claude-sonnet-4',
        });
        
        currentThreadId = createResult.thread_id;
        console.log('[useChat] Thread created:', currentThreadId, 'Agent Run:', createResult.agent_run_id);
        
        // Set thread ID first
        setActiveThreadId(currentThreadId);
        
        // Set agent run ID after a delay
        if (createResult.agent_run_id) {
          setTimeout(() => {
            console.log('[useChat] Setting agent run ID:', createResult.agent_run_id);
            setAgentRunId(createResult.agent_run_id);
          }, 100);
        }
        
        // Clear input AFTER successful send
        setInputValue('');
        setAttachments([]);
      } else {
        // EXISTING THREAD: Send message + start agent run
        console.log('[useChat] Sending to existing thread:', currentThreadId);
        
        const result = await sendMessageMutation.mutateAsync({
          threadId: currentThreadId,
          message: content,
          modelName: 'claude-sonnet-4',
        });
        
        console.log('[useChat] Message sent, agent run started:', result.agentRunId);
        
        // Set agent run ID
        if (result.agentRunId) {
          setAgentRunId(result.agentRunId);
        }
        
        // Clear input AFTER successful send
        setInputValue('');
        setAttachments([]);
      }
    } catch (error) {
      console.error('[useChat] Error sending message:', error);
      throw error;
    }
  }, [activeThreadId, sendMessageMutation, initiateAgentMutation]);

  const stopAgent = useCallback(() => {
    if (agentRunId) {
      console.log('[useChat] Stopping agent run:', agentRunId);
      
      // Clear UI state immediately for instant feedback
      const runIdToStop = agentRunId;
      setAgentRunId(null);
      stopStreaming();
      
      // Make API call to stop on backend
      stopAgentRunMutation.mutate(runIdToStop, {
        onSuccess: () => {
          console.log('[useChat] Agent run stopped successfully');
        },
        onError: (error) => {
          console.error('[useChat] Failed to stop agent run:', error);
        }
      });
    }
  }, [agentRunId, stopAgentRunMutation, stopStreaming]);

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
    setIsAttachmentDrawerVisible(true);
  }, []);

  const closeAttachmentDrawer = useCallback(() => {
    console.log('[useChat] Closing attachment drawer');
    setIsAttachmentDrawerVisible(false);
  }, []);

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

  const isAgentRunning = !!agentRunId || isStreaming;
  const isSendingMessage = sendMessageMutation.isPending || initiateAgentMutation.isPending;
  
  // Compute isLoading: true when thread data or messages are being fetched
  const isLoading = (isThreadLoading || isMessagesLoading) && !!activeThreadId;

  // ============================================================================
  // Return Public API
  // ============================================================================

  return {
    // Thread Management
    activeThread,
    threads: threadsData,
    loadThread,
    startNewChat,
    hasActiveThread: !!activeThreadId,
    
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
  };
}

