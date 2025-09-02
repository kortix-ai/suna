import {
    addUserMessage,
    BillingError,
    createThreadForProject,
    getAgentRuns,
    getMessages,
    getThreadForProject,
    initiateAgent,
    Message,
    ParsedContent,
    parseStreamContent,
    startAgent,
    stopAgent,
    streamAgent,
    Thread
} from '@/api/chat-api';
import { projectKeys } from '@/api/project-api';
import { createSupabaseClient } from '@/constants/SupabaseConfig';
import { useNewChatSessionKey, useSetIsGenerating, useUpdateNewChatProject } from '@/stores/ui-store';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

// Query Keys
export const chatKeys = {
    all: ['chat'] as const,
    threads: () => [...chatKeys.all, 'threads'] as const,
    thread: (projectId: string) => [...chatKeys.threads(), projectId] as const,
    messages: () => [...chatKeys.all, 'messages'] as const,
    messagesForThread: (threadId: string) => [...chatKeys.messages(), threadId] as const,
    agentRuns: () => [...chatKeys.all, 'agentRuns'] as const,
    agentRunsForThread: (threadId: string) => [...chatKeys.agentRuns(), threadId] as const,
};

// Thread Hooks
export const useThreadForProject = (projectId: string) => {
    return useQuery({
        queryKey: chatKeys.thread(projectId),
        queryFn: () => getThreadForProject(projectId),
        enabled: !!projectId && projectId !== '' && projectId !== 'new-chat-temp',
        staleTime: 5 * 60 * 1000,
        retry: 1,
    });
};

export const useCreateThreadForProject = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ projectId }: { projectId: string }) => createThreadForProject(projectId),
        onSuccess: (thread) => {
            queryClient.setQueryData(chatKeys.thread(thread.project_id), thread);
            queryClient.invalidateQueries({ queryKey: chatKeys.messagesForThread(thread.thread_id) });
        },
    });
};

// Message Hooks
export const useMessages = (threadId: string) => {
    return useQuery({
        queryKey: chatKeys.messagesForThread(threadId),
        queryFn: () => getMessages(threadId),
        enabled: !!threadId && threadId !== '',
        staleTime: 30 * 1000,
        refetchInterval: !!threadId && threadId !== '' ? 5000 : false,
        retry: 1,
    });
};

export const useAddMessage = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ threadId, content }: { threadId: string; content: string }) =>
            addUserMessage(threadId, content),
        onSuccess: (data, { threadId }) => {
            queryClient.invalidateQueries({ queryKey: chatKeys.messagesForThread(threadId) });
        },
    });
};

// Agent Hooks
export const useAgentRuns = (threadId: string) => {
    return useQuery({
        queryKey: chatKeys.agentRunsForThread(threadId),
        queryFn: () => getAgentRuns(threadId),
        enabled: !!threadId,
        staleTime: 30 * 1000,
        retry: 1,
    });
};

export const useStartAgent = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            threadId,
            options,
        }: {
            threadId: string;
            options?: {
                model_name?: string;
                enable_thinking?: boolean;
                reasoning_effort?: string;
                stream?: boolean;
                agent_id?: string;
            };
        }) => startAgent(threadId, options),
        onSuccess: (data, { threadId }) => {
            queryClient.invalidateQueries({ queryKey: chatKeys.agentRunsForThread(threadId) });
        },
        onError: (error) => {
            if (!(error instanceof BillingError)) {
                console.error('Failed to start agent:', error);
            }
        },
    });
};

export const useStopAgent = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (agentRunId: string) => stopAgent(agentRunId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: chatKeys.agentRuns() });
        },
    });
};

// EXACT FRONTEND PATTERN - Stream Hook Callbacks
export interface AgentStreamCallbacks {
    onMessage: (message: Message) => void;
    onStatusChange?: (status: string) => void;
    onError?: (error: string) => void;
    onClose?: (finalStatus: string) => void;
}

// EXACT FRONTEND PATTERN - useAgentStream Result
export interface UseAgentStreamResult {
    status: string;
    textContent: string;
    toolCall: ParsedContent | null;
    error: string | null;
    agentRunId: string | null;
    startStreaming: (runId: string) => void;
    stopStreaming: () => Promise<void>;
}

// EXACT FRONTEND PATTERN - useAgentStream Hook
export const useAgentStream = (
    callbacks: AgentStreamCallbacks,
    threadId: string,
    setMessages: (messages: Message[]) => void,
): UseAgentStreamResult => {
    const [agentRunId, setAgentRunId] = useState<string | null>(null);
    const [status, setStatus] = useState<string>('idle');
    const [textContent, setTextContent] = useState<string>('');
    const [toolCall, setToolCall] = useState<ParsedContent | null>(null);
    const [error, setError] = useState<string | null>(null);

    const streamCleanupRef = useRef<(() => void) | null>(null);
    const isMountedRef = useRef<boolean>(true);
    const currentRunIdRef = useRef<string | null>(null);
    const threadIdRef = useRef(threadId);
    const setMessagesRef = useRef(setMessages);

    // Update refs
    useEffect(() => {
        threadIdRef.current = threadId;
    }, [threadId]);

    useEffect(() => {
        setMessagesRef.current = setMessages;
    }, [setMessages]);

    // Update status and notify
    const updateStatus = useCallback((newStatus: string) => {
        if (isMountedRef.current) {
            setStatus(newStatus);
            callbacks.onStatusChange?.(newStatus);
            if (newStatus === 'error' && error) {
                callbacks.onError?.(error);
            }
            if (['completed', 'stopped', 'failed', 'error', 'agent_not_running'].includes(newStatus)) {
                callbacks.onClose?.(newStatus);
            }
        }
    }, [callbacks, error]);

    // EXACT FRONTEND PATTERN - Finalize stream
    const finalizeStream = useCallback((finalStatus: string, runId: string | null = agentRunId) => {
        if (!isMountedRef.current) return;

        const currentThreadId = threadIdRef.current;
        const currentSetMessages = setMessagesRef.current;


        if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
        }

        // Reset streaming state
        setTextContent('');
        setToolCall(null);
        updateStatus(finalStatus);
        setAgentRunId(null);
        currentRunIdRef.current = null;

        // EXACT FRONTEND PATTERN - Refetch messages on finalization
        const terminalStatuses = ['completed', 'stopped', 'failed', 'error', 'agent_not_running'];
        if (currentThreadId && terminalStatuses.includes(finalStatus)) {
            getMessages(currentThreadId)
                .then((messagesData: Message[]) => {
                    if (isMountedRef.current && messagesData) {
                        currentSetMessages(messagesData);
                    }
                })
                .catch((err) => {
                    console.error(`[useAgentStream] Error refetching messages:`, err);
                });
        }
    }, [agentRunId, updateStatus]);

    // EXACT FRONTEND PATTERN - Stream message handler
    const handleStreamMessage = useCallback((rawData: string) => {
        if (!isMountedRef.current) return;

        let processedData = rawData;
        if (processedData.startsWith('data: ')) {
            processedData = processedData.substring(6).trim();
        }
        if (!processedData) return;

        // Check for completion messages
        if (processedData.includes('Run data not available for streaming') ||
            processedData.includes('Stream ended with status: completed') ||
            processedData.includes('"status": "completed"')) {
            finalizeStream('completed', currentRunIdRef.current);
            return;
        }

        try {
            const jsonData = JSON.parse(processedData);

            // Handle error status
            if (jsonData.status === 'error') {
                console.error('[useAgentStream] Received error status:', jsonData);
                const errorMessage = jsonData.message || 'Unknown error occurred';
                setError(errorMessage);
                callbacks.onError?.(errorMessage);
                return;
            }

            // Handle completion status
            if (jsonData.status === 'completed') {
                finalizeStream('completed', currentRunIdRef.current);
                return;
            }

            const parsedContent = JSON.parse(jsonData.content || '{}');
            const parsedMetadata = JSON.parse(jsonData.metadata || '{}');

            // Update status to streaming
            if (status !== 'streaming') {
                updateStatus('streaming');
            }

            switch (jsonData.type) {
                case 'assistant':
                    if (parsedMetadata.stream_status === 'chunk' && parsedContent.content) {
                        setTextContent(prev => prev + parsedContent.content);
                    } else if (parsedMetadata.stream_status === 'complete') {
                        setTextContent('');
                        setToolCall(null);
                        if (jsonData.message_id) {
                            callbacks.onMessage(jsonData);
                        }
                    } else if (!parsedMetadata.stream_status && parsedContent.content) {
                        setTextContent(prev => prev + parsedContent.content);
                    }
                    break;

                case 'tool':
                    setToolCall(null);
                    if (jsonData.message_id) {
                        callbacks.onMessage(jsonData);
                    }
                    break;

                case 'status':
                    switch (parsedContent.status_type) {
                        case 'tool_started':
                            setToolCall({
                                type: 'tool_call',
                                content: `Tool: ${parsedContent.function_name || 'Unknown'}`,
                                role: 'assistant',
                                status_type: 'tool_started',
                                name: parsedContent.function_name,
                                arguments: parsedContent.arguments,
                                xml_tag_name: parsedContent.xml_tag_name,
                                tool_index: parsedContent.tool_index,
                            });
                            break;
                        case 'tool_completed':
                        case 'tool_failed':
                        case 'tool_error':
                            if (toolCall?.tool_index === parsedContent.tool_index) {
                                setToolCall(null);
                            }
                            break;
                        case 'thread_run_end':
                            console.log('[useAgentStream] Thread run end');
                            finalizeStream('completed', currentRunIdRef.current);
                            break;
                        case 'error':
                            setError(parsedContent.message || 'Agent run failed');
                            finalizeStream('error', currentRunIdRef.current);
                            break;
                    }
                    break;

                case 'user':
                case 'system':
                    if (jsonData.message_id) {
                        callbacks.onMessage(jsonData);
                    }
                    break;
            }
        } catch (parseError) {
            // Fallback parsing
            const parsed = parseStreamContent(processedData);
            if (parsed?.type === 'text') {
                setTextContent(prev => prev + parsed.content);
            }
        }
    }, [status, toolCall, finalizeStream, updateStatus, callbacks]);

    // EXACT FRONTEND PATTERN - Stream error handler
    const handleStreamError = useCallback((err: Error | string) => {
        if (!isMountedRef.current) return;

        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[useAgentStream] Stream error:', errorMessage);
        setError(errorMessage);
        finalizeStream('error', currentRunIdRef.current);
    }, [finalizeStream]);

    // EXACT FRONTEND PATTERN - Stream close handler
    const handleStreamClose = useCallback(() => {
        if (!isMountedRef.current) return;
        console.log('[useAgentStream] Stream closed');
        if (status === 'streaming' || status === 'connecting') {
            finalizeStream('completed', currentRunIdRef.current);
        }
    }, [status, finalizeStream]);

    // EXACT FRONTEND PATTERN - Start streaming
    const startStreaming = useCallback((runId: string) => {
        if (!isMountedRef.current) return;

        if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
        }

        console.log(`[useAgentStream] Starting stream for run ${runId}`);
        setAgentRunId(runId);
        currentRunIdRef.current = runId;
        setTextContent('');
        setToolCall(null);
        setError(null);
        updateStatus('connecting');

        const cleanup = streamAgent(runId, {
            onMessage: handleStreamMessage,
            onError: handleStreamError,
            onClose: handleStreamClose,
        });

        streamCleanupRef.current = cleanup;
    }, [handleStreamMessage, handleStreamError, handleStreamClose, updateStatus]);

    // EXACT FRONTEND PATTERN - Stop streaming
    const stopStreaming = useCallback(async () => {
        console.log('[useAgentStream] Stopping stream');
        if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
        }
        finalizeStream('stopped', currentRunIdRef.current);
    }, [finalizeStream]);

    // Cleanup on unmount
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            if (streamCleanupRef.current) {
                streamCleanupRef.current();
            }
        };
    }, []);

    return {
        status,
        textContent,
        toolCall,
        error,
        agentRunId,
        startStreaming,
        stopStreaming,
    };
};

// EXACT FRONTEND PATTERN - Chat Session Hook
export const useChatSession = (projectId: string) => {
    const isNewChat = projectId === 'new-chat-temp';
    const sessionKey = useNewChatSessionKey();

    // State
    const [threadId, setThreadId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isInitialized, setIsInitialized] = useState(false);
    const [isSending, setIsSending] = useState(false);

    // Reset on session change
    useEffect(() => {
        if (isNewChat) {
            console.log('[useChatSession] Session reset - clearing all messages');
            setThreadId(null);
            setMessages([]);
            setIsInitialized(false);
            setIsSending(false);
        }
    }, [sessionKey, isNewChat]);

    // Hooks
    const queryClient = useQueryClient();
    const { data: thread, isLoading: threadLoading } = useThreadForProject(isNewChat ? '' : projectId);
    const createThread = useCreateThreadForProject();
    const { data: rawApiMessages = [], isLoading: messagesLoading } = useMessages(threadId || thread?.thread_id || '');
    const addMessage = useAddMessage();
    const startAgentMutation = useStartAgent();
    const stopAgentMutation = useStopAgent();
    const setIsGenerating = useSetIsGenerating();
    const updateNewChatProject = useUpdateNewChatProject();

    // EXACT FRONTEND PATTERN - Stream message handler
    const handleNewMessageFromStream = useCallback((message: Message) => {
        console.log(`[STREAM HANDLER] Received message: ID=${message.message_id}, Type=${message.type}`);

        setMessages((prev) => {
            const messageExists = prev.some(m => m.message_id === message.message_id);
            if (messageExists) {
                return prev.map(m => m.message_id === message.message_id ? message : m);
            } else {
                return [...prev, message];
            }
        });
    }, []);

    // EXACT FRONTEND PATTERN - Stream status handler
    const handleStreamStatusChange = useCallback((hookStatus: string) => {
        console.log(`[useChatSession] Hook status changed: ${hookStatus}`);
        switch (hookStatus) {
            case 'idle':
            case 'completed':
            case 'stopped':
            case 'agent_not_running':
            case 'error':
            case 'failed':
                setIsGenerating(false);
                break;
            case 'connecting':
            case 'streaming':
                setIsGenerating(true);
                break;
        }
    }, [setIsGenerating]);

    // Agent stream hook
    const agentStream = useAgentStream({
        onMessage: handleNewMessageFromStream,
        onStatusChange: handleStreamStatusChange,
        onError: (error) => console.error('[useChatSession] Stream error:', error),
        onClose: (finalStatus) => console.log('[useChatSession] Stream closed:', finalStatus),
    }, threadId || thread?.thread_id || '', setMessages);

    // Sync API messages to local state
    useEffect(() => {
        if (rawApiMessages.length > 0) {
            console.log(`[useChatSession] Syncing ${rawApiMessages.length} API messages`);
            setMessages(rawApiMessages);
        }
    }, [rawApiMessages]);

    // Thread info for new chat
    const { data: threadInfo } = useQuery({
        queryKey: ['thread', threadId],
        queryFn: async () => {
            if (!threadId || !isNewChat) return null;
            const supabase = createSupabaseClient();
            const { data } = await supabase
                .from('threads')
                .select(`*, projects!inner(*)`)
                .eq('thread_id', threadId)
                .single();
            return data;
        },
        enabled: !!threadId && isNewChat && isInitialized,
        staleTime: Infinity,
    });

    // Update new chat project
    useEffect(() => {
        if (threadInfo?.projects && isNewChat) {
            const projectData = threadInfo.projects;
            updateNewChatProject({
                id: projectData.project_id,
                name: projectData.name || 'Untitled Project',
                description: projectData.description || '',
                account_id: projectData.account_id,
                created_at: projectData.created_at,
                updated_at: projectData.updated_at,
                sandbox: projectData.sandbox || {},
            });
            queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
        }
    }, [threadInfo, updateNewChatProject, queryClient, isNewChat]);

    // Start stream effect
    useEffect(() => {
        if (agentStream.agentRunId && threadId) {
            console.log(`[useChatSession] Starting stream for run ${agentStream.agentRunId}`);
            agentStream.startStreaming(agentStream.agentRunId);
        }
    }, [agentStream.agentRunId, threadId]);

    // EXACT FRONTEND PATTERN - Send message
    const sendMessage = useCallback(async (content: string, files?: any[]) => {
        if (!content.trim()) return;
        if (isSending) {
            console.log('[useChatSession] Already sending, ignoring duplicate');
            return;
        }

        setIsSending(true);

        // EXACT FRONTEND PATTERN - Simple optimistic message
        const optimisticUserMessage: Message = {
            message_id: `temp-${Date.now()}`,  // EXACT FRONTEND PREFIX
            thread_id: threadId || 'temp',
            type: 'user',
            is_llm_message: false,
            content: { role: 'user', content },
            metadata: files ? { cached_files: files } : {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        setMessages(prev => [...prev, optimisticUserMessage]);

        try {
            if (isNewChat && !threadId) {
                // New chat - initialize
                if (!isInitialized) {
                    updateNewChatProject({
                        id: 'new-chat-temp',
                        name: 'New Chat',
                        description: 'Temporary project for new chat',
                        account_id: '',
                        sandbox: {},
                    });
                    setIsInitialized(true);
                }

                const result = await initiateAgent(content.trim(), {
                    stream: true,
                    enable_context_manager: true,
                    files: files
                });

                setThreadId(result.thread_id);
                agentStream.startStreaming(result.agent_run_id);
            } else {
                // Existing thread
                const currentThreadId = threadId || thread?.thread_id;
                if (!currentThreadId) {
                    const newThread = await createThread.mutateAsync({ projectId });
                    await addMessage.mutateAsync({
                        threadId: newThread.thread_id,
                        content: content.trim(),
                    });
                    const result = await startAgentMutation.mutateAsync({
                        threadId: newThread.thread_id,
                    });
                    agentStream.startStreaming(result.agent_run_id);
                } else {
                    const messagePromise = addMessage.mutateAsync({
                        threadId: currentThreadId,
                        content: content.trim(),
                    });
                    const agentPromise = startAgentMutation.mutateAsync({
                        threadId: currentThreadId,
                    });
                    const results = await Promise.allSettled([messagePromise, agentPromise]);

                    if (results[0].status === 'rejected') {
                        throw new Error(`Failed to send message: ${results[0].reason?.message || results[0].reason}`);
                    }
                    if (results[1].status === 'rejected') {
                        const error = results[1].reason;
                        if (error instanceof BillingError) {
                            // EXACT FRONTEND PATTERN - Remove optimistic message on billing error
                            setMessages(prev => prev.filter(m => m.message_id !== optimisticUserMessage.message_id));
                            setIsSending(false);
                            return;
                        }
                        throw new Error(`Failed to start agent: ${error?.message || error}`);
                    }

                    const agentResult = results[1].value;
                    agentStream.startStreaming(agentResult.agent_run_id);
                }
            }
        } catch (error) {
            console.error('[useChatSession] Failed to send message:', error);
            // EXACT FRONTEND PATTERN - Remove optimistic message on error
            setMessages(prev => prev.filter(m => m.message_id !== optimisticUserMessage.message_id));
            throw error;
        } finally {
            setIsSending(false);
        }
    }, [threadId, thread, isNewChat, isInitialized, isSending, agentStream, addMessage, startAgentMutation, createThread, projectId, updateNewChatProject]);

    const stopAgent = useCallback(async () => {
        await agentStream.stopStreaming();
        if (agentStream.agentRunId) {
            stopAgentMutation.mutate(agentStream.agentRunId);
        }
    }, [agentStream, stopAgentMutation]);

    return {
        thread: thread || (threadId ? { thread_id: threadId } : null),
        messages,
        threadId: threadId || thread?.thread_id,
        isInitialized: isNewChat ? isInitialized : true,
        isLoading: threadLoading || messagesLoading,
        isLoadingThread: threadLoading,
        isLoadingMessages: messagesLoading,
        sendMessage,
        stopAgent,
        isGenerating: agentStream.status === 'streaming' || agentStream.status === 'connecting' || isSending,
        streamStatus: agentStream.status,
        streamContent: agentStream.textContent,
        streamError: agentStream.error,
        isSending,
    };
};

// For backward compatibility
export const useNewChatSession = () => {
    return useChatSession('new-chat-temp');
};

// Utility hook to get or create thread for project
export const useEnsureThread = (projectId: string) => {
    const { data: thread, isLoading } = useThreadForProject(projectId);
    const createThread = useCreateThreadForProject();

    const ensureThread = useCallback(async (): Promise<Thread> => {
        if (thread) {
            return thread;
        }
        const newThread = await createThread.mutateAsync({ projectId });
        return newThread;
    }, [thread, createThread, projectId]);

    return {
        thread,
        isLoading: isLoading || createThread.isPending,
        ensureThread,
    };
}; 