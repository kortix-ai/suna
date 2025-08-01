'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChatInput, ChatInputHandles } from '@/components/thread/chat-input/chat-input';
import { ThreadContent } from '@/components/thread/content/ThreadContent';
import { useAgentStream } from '@/hooks/useAgentStream';
import { useAddUserMessageMutation } from '@/hooks/react-query/threads/use-messages';
import { useStartAgentMutation, useStopAgentMutation } from '@/hooks/react-query/threads/use-agent-run';
import { useInitiateAgentWithInvalidation } from '@/hooks/react-query/dashboard/use-initiate-agent';
import { useAgentBuilderChatHistory } from '@/hooks/react-query/agents/use-agents';
import { toast } from 'sonner';
import { UnifiedMessage } from '@/components/thread/types';
import { BillingError } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { agentKeys } from '@/hooks/react-query/agents/keys';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { useAgentRunsQuery } from '@/hooks/react-query/threads/use-agent-run';

interface AgentBuilderChatProps {
  agentId: string;
  formData: any;
  handleFieldChange: (field: string, value: any) => void;
  handleStyleChange: (emoji: string, color: string) => void;
  currentStyle: { avatar: string; color: string };
}

export const AgentBuilderChat = React.memo(function AgentBuilderChat({
  agentId,
  formData,
  handleFieldChange,
  handleStyleChange,
  currentStyle
}: AgentBuilderChatProps) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'connecting' | 'error'>('idle');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasStartedConversation, setHasStartedConversation] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandles>(null);
  const previousMessageCountRef = useRef(0);
  const hasInitiallyLoadedRef = useRef(false);
  const previousAgentIdRef = useRef<string | null>(null);
  const agentRunsCheckedRef = useRef(false);

  // Debug mount/unmount
  useEffect(() => {
    console.log('[AgentBuilderChat] Component mounted');
    return () => {
      console.log('[AgentBuilderChat] Component unmounted');
    };
  }, []);

  // Reset hasInitiallyLoadedRef when agentId changes
  useEffect(() => {
    if (previousAgentIdRef.current !== null && previousAgentIdRef.current !== agentId) {
      console.log('[AgentBuilderChat] Agent ID changed, resetting state');
      hasInitiallyLoadedRef.current = false;
      setMessages([]);
      setThreadId(null);
      setAgentRunId(null);
      setHasStartedConversation(false);
      previousMessageCountRef.current = 0;
      agentRunsCheckedRef.current = false;
    }
    previousAgentIdRef.current = agentId;
  }, [agentId]);

  const initiateAgentMutation = useInitiateAgentWithInvalidation();
  const addUserMessageMutation = useAddUserMessageMutation();
  const startAgentMutation = useStartAgentMutation();
  const stopAgentMutation = useStopAgentMutation();
  const chatHistoryQuery = useAgentBuilderChatHistory(agentId);
  const agentRunsQuery = useAgentRunsQuery(threadId || '');
  const queryClient = useQueryClient();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Check if user is at the bottom of the chat
  const isUserAtBottom = useCallback(() => {
    if (!messagesEndRef.current?.parentElement) return true;
    const container = messagesEndRef.current.parentElement;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50; // 50px threshold
  }, []);

  useEffect(() => {
    if (messages && messages.length > previousMessageCountRef.current) {
      scrollToBottom();
    }
    previousMessageCountRef.current = messages?.length || 0;
  }, [messages, messages?.length]);

  // Auto-scroll during streaming only if user is at bottom
  useEffect(() => {
    if ((agentStatus === 'running' || agentStatus === 'connecting') && isUserAtBottom()) {
      scrollToBottom();
    }
  }, [agentStatus, isUserAtBottom]);

  useEffect(() => {
    if (chatHistoryQuery.data && chatHistoryQuery.status === 'success' && !hasInitiallyLoadedRef.current) {
      console.log('[AgentBuilderChat] Loading chat history for agent:', agentId);
      const { messages: historyMessages, thread_id } = chatHistoryQuery.data;
      if (historyMessages && historyMessages.length > 0) {
        const unifiedMessages = historyMessages
          .filter((msg) => msg.type !== 'status')
          .map((msg: any) => ({
            message_id: msg.message_id || `msg-${Date.now()}-${Math.random()}`,
            thread_id: msg.thread_id || thread_id,
            type: (msg.type || 'system') as UnifiedMessage['type'],
            is_llm_message: Boolean(msg.is_llm_message),
            content: msg.content || '',
            metadata: msg.metadata || '{}',
            created_at: msg.created_at || new Date().toISOString(),
            updated_at: msg.updated_at || new Date().toISOString(),
            sequence: 0,
          }));
        setMessages(unifiedMessages);
        setHasStartedConversation(unifiedMessages.length > 0);
        previousMessageCountRef.current = unifiedMessages.length;
        if (thread_id) {
          setThreadId(thread_id);
        }
      }

      hasInitiallyLoadedRef.current = true;
    } else if (chatHistoryQuery.status === 'error') {
      console.error('[AgentBuilderChat] Error loading chat history:', chatHistoryQuery.error);
      hasInitiallyLoadedRef.current = true;
    }
  }, [chatHistoryQuery.data, chatHistoryQuery.status, chatHistoryQuery.error, agentId]);

  useEffect(() => {
    if (threadId && agentRunsQuery.data && !agentRunsCheckedRef.current) {
      console.log('[AgentBuilderChat] Checking for active agent runs...');
      agentRunsCheckedRef.current = true;

      const activeRun = agentRunsQuery.data.find((run) => run.status === 'running');
      if (activeRun) {
        console.log('[AgentBuilderChat] Found active run on load:', activeRun.id);
        setAgentRunId(activeRun.id);
        setAgentStatus('connecting');
      } else {
        console.log('[AgentBuilderChat] No active agent runs found');
        setAgentStatus('idle');
      }
    }
  }, [threadId, agentRunsQuery.data]);

  const handleNewMessageFromStream = useCallback((message: UnifiedMessage) => {
    setMessages((prev) => {
      if (!prev) prev = [];

      if (message.type === 'user') {
        const optimisticIndex = prev.findIndex(m =>
          m.message_id.startsWith('temp-user-') &&
          m.content === message.content &&
          m.type === 'user'
        );

        if (optimisticIndex !== -1) {
          console.log(`[AGENT BUILDER] Replacing optimistic message with real message`);
          const newMessages = [...prev];
          newMessages[optimisticIndex] = message;
          return newMessages;
        }
      }
      const messageExists = prev.some(m => m.message_id === message.message_id);
      if (messageExists) {
        return prev.map(m => m.message_id === message.message_id ? message : m);
      }
      return [...prev, message];
    });
  }, []);

  const handleStreamStatusChange = useCallback((status: string) => {
    switch (status) {
      case 'idle':
      case 'completed':
      case 'stopped':
      case 'agent_not_running':
      case 'error':
      case 'failed':
        setAgentStatus('idle');
        setAgentRunId(null);
        if (status === 'completed') {
          setSaveStatus('saved');
          queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
          queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
          queryClient.invalidateQueries({ queryKey: agentKeys.builderChatHistory(agentId) });
          setTimeout(() => setSaveStatus('idle'), 2000);
        }
        break;
      case 'connecting':
        setAgentStatus('connecting');
        break;
      case 'streaming':
        setAgentStatus('running');
        break;
    }
  }, [queryClient, agentId]);

  const handleStreamError = useCallback((errorMessage: string) => {
    if (!errorMessage.toLowerCase().includes('not found') &&
      !errorMessage.toLowerCase().includes('agent run is not running')) {
      toast.error(`Stream Error: ${errorMessage}`);
    }
  }, []);

  const handleStreamClose = useCallback(() => {
    console.log(`[AGENT BUILDER] Stream closed`);
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
    },
    threadId,
    setMessages,
  );

  useEffect(() => {
    if (agentRunId && agentRunId !== currentHookRunId) {
      console.log(`[AgentBuilderChat] Target agentRunId set to ${agentRunId}, initiating stream...`);
      startStreaming(agentRunId);
    }
  }, [agentRunId, startStreaming, currentHookRunId]);

  const handleSubmitFirstMessage = async (
    message: string,
    options?: {
      model_name?: string;
      enable_thinking?: boolean;
      reasoning_effort?: string;
      stream?: boolean;
      enable_context_manager?: boolean;
    },
  ) => {
    if (!message.trim() && !chatInputRef.current?.getPendingFiles().length) return;

    setIsSubmitting(true);
    setHasStartedConversation(true);
    setSaveStatus('saving');

    try {
      const files = chatInputRef.current?.getPendingFiles() || [];

      const agentFormData = new FormData();
      agentFormData.append('prompt', message);
      agentFormData.append('is_agent_builder', String(true));
      agentFormData.append('target_agent_id', agentId);

      files.forEach((file) => {
        const normalizedName = normalizeFilenameToNFC(file.name);
        agentFormData.append('files', file, normalizedName);
      });

      if (options?.model_name) agentFormData.append('model_name', options.model_name);
      agentFormData.append('enable_thinking', String(options?.enable_thinking ?? false));
      agentFormData.append('reasoning_effort', options?.reasoning_effort ?? 'low');
      agentFormData.append('stream', String(options?.stream ?? true));
      agentFormData.append('enable_context_manager', String(options?.enable_context_manager ?? false));

      const result = await initiateAgentMutation.mutateAsync(agentFormData);

      if (result.thread_id) {
        setThreadId(result.thread_id);
        if (result.agent_run_id) {
          console.log('[AGENT BUILDER] Setting agent run ID:', result.agent_run_id);
          setAgentRunId(result.agent_run_id);
        }

        const userMessage: UnifiedMessage = {
          message_id: `user-${Date.now()}`,
          thread_id: result.thread_id,
          type: 'user',
          is_llm_message: false,
          content: message,
          metadata: '{}',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          sequence: 0,
        };
        setMessages(prev => [...prev, userMessage]);
      }

      chatInputRef.current?.clearPendingFiles();
      setInputValue('');
    } catch (error: any) {
      if (error instanceof BillingError) {
        toast.error('Billing limit reached. Please upgrade your plan.');
      } else {
        toast.error('Failed to start agent builder session');
      }
      setHasStartedConversation(false);
      setSaveStatus('idle');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitMessage = useCallback(
    async (
      message: string,
      options?: { model_name?: string; enable_thinking?: boolean; reasoning_effort?: string; enable_context_manager?: boolean },
    ) => {
      if (!message.trim() || !threadId) return;
      setIsSubmitting(true);
      setSaveStatus('saving');

      const optimisticUserMessage: UnifiedMessage = {
        message_id: `temp-user-${Date.now()}-${Math.random()}`,
        thread_id: threadId,
        type: 'user',
        is_llm_message: false,
        content: message,
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sequence: messages.length,
      };

      setMessages((prev) => [...prev, optimisticUserMessage]);
      setInputValue('');

      try {
        const messagePromise = addUserMessageMutation.mutateAsync({
          threadId,
          message
        });

        const agentPromise = startAgentMutation.mutateAsync({
          threadId,
          options
        });

        const results = await Promise.allSettled([messagePromise, agentPromise]);

        if (results[0].status === 'rejected') {
          throw new Error(`Failed to send message: ${results[0].reason?.message || results[0].reason}`);
        }
        if (results[1].status === 'rejected') {
          const error = results[1].reason;
          if (error instanceof BillingError) {
            toast.error('Billing limit reached. Please upgrade your plan.');
            setMessages(prev => prev.filter(m => m.message_id !== optimisticUserMessage.message_id));
            return;
          }
          throw new Error(`Failed to start agent: ${error?.message || error}`);
        }
        const agentResult = results[1].value;
        setAgentRunId(agentResult.agent_run_id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Operation failed');
        setMessages((prev) => prev.map((m) =>
          m.message_id === optimisticUserMessage.message_id
            ? { ...m, message_id: `user-error-${Date.now()}` }
            : m
        ));
        setSaveStatus('idle');
      } finally {
        setIsSubmitting(false);
      }
    },
    [threadId, messages?.length, addUserMessageMutation, startAgentMutation],
  );

  const handleStopAgent = useCallback(async () => {
    setAgentStatus('idle');
    await stopStreaming();

    if (agentRunId) {
      try {
        await stopAgentMutation.mutateAsync(agentRunId);
      } catch (error) {
        console.error('[AGENT BUILDER] Error stopping agent:', error);
      }
    }
  }, [stopStreaming, agentRunId, stopAgentMutation]);


  const handleOpenFileViewer = useCallback(() => { }, []);


  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto scrollbar-hide">
          <ThreadContent
            messages={messages || []}
            streamingTextContent={streamingTextContent}
            streamingToolCall={streamingToolCall}
            agentStatus={agentStatus}
            handleToolClick={() => { }}
            handleOpenFileViewer={handleOpenFileViewer}
            streamHookStatus={streamHookStatus}
            agentName="Agent Builder"
            agentAvatar={'🤖'}
            emptyStateComponent={
              <div className="mt-6 flex flex-col items-center text-center text-muted-foreground/80">
                <div className="flex w-20 aspect-square items-center justify-center rounded-2xl bg-muted-foreground/10 p-4 mb-4">
                  <div className="text-4xl">🤖</div>
                </div>
                <p className='w-[60%] text-2xl'>I'm your <span className='text-primary/80 font-semibold'>Agent Builder</span>. Describe the exact workflows and tasks you want to automate, and I'll configure your agent to handle them.</p>
              </div>
            }
          />
          <div ref={messagesEndRef} />
        </div>
      </div>
      <div className="flex-shrink-0 md:pb-4 md:px-6 px-4">
        <ChatInput
          ref={chatInputRef}
          onSubmit={threadId ? handleSubmitMessage : handleSubmitFirstMessage}
          loading={isSubmitting}
          placeholder="Tell me how you'd like to configure your agent..."
          value={inputValue}
          onChange={setInputValue}
          disabled={isSubmitting}
          isAgentRunning={agentStatus === 'running' || agentStatus === 'connecting'}
          onStopAgent={handleStopAgent}
          agentName="Agent Builder"
          hideAttachments={true}
          bgColor='bg-muted-foreground/10'
          hideAgentSelection={true}
        />
      </div>
    </div>
  );
}, (prevProps, nextProps) => {

  return (
    prevProps.agentId === nextProps.agentId &&
    JSON.stringify(prevProps.formData) === JSON.stringify(nextProps.formData) &&
    prevProps.currentStyle.avatar === nextProps.currentStyle.avatar &&
    prevProps.currentStyle.color === nextProps.currentStyle.color &&
    prevProps.handleFieldChange === nextProps.handleFieldChange &&
    prevProps.handleStyleChange === nextProps.handleStyleChange
  );
}); 