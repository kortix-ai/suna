import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { Project } from '@/lib/api/threads';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import { useMessagesQuery } from '@/hooks/messages';
import { useProjectQuery } from '@/hooks/threads/use-project';
import { useAgentRunsQuery } from '@/hooks/threads/use-agent-run';
import { ApiMessageType, UnifiedMessage, AgentStatus } from '@/components/thread/types';
import { extractUserMessageText } from '@/components/thread/utils';
import { getStreamPreconnectService } from '@/lib/streaming/stream-preconnect';

interface UseThreadDataReturn {
  messages: UnifiedMessage[];
  setMessages: React.Dispatch<React.SetStateAction<UnifiedMessage[]>>;
  project: Project | null;
  sandboxId: string | null;
  projectName: string;
  agentRunId: string | null;
  setAgentRunId: React.Dispatch<React.SetStateAction<string | null>>;
  agentStatus: AgentStatus;
  setAgentStatus: React.Dispatch<React.SetStateAction<AgentStatus>>;
  isLoading: boolean;
  error: string | null;
  initialLoadCompleted: boolean;
  threadQuery: ReturnType<typeof useThreadQuery>;
  messagesQuery: ReturnType<typeof useMessagesQuery>;
  projectQuery: ReturnType<typeof useProjectQuery>;
  agentRunsQuery: ReturnType<typeof useAgentRunsQuery>;
}

interface UseThreadDataOptions {
  waitingForAgent?: boolean;
}

export function useThreadData(
  threadId: string, 
  projectId: string, 
  isShared: boolean = false,
  options?: UseThreadDataOptions
): UseThreadDataReturn {
  const { waitingForAgent = false } = options || {};
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const initialLoadCompleted = useRef<boolean>(false);
  const messagesLoadedRef = useRef(false);
  const foundRunningAgentRef = useRef(false);
  const hasInitiallyScrolled = useRef<boolean>(false);
  const lastDetectedRunIdRef = useRef<string | null>(null);
  
  const retryCountRef = useRef(0);

  const threadQuery = useThreadQuery(threadId);
  const messagesQuery = useMessagesQuery(threadId, {
    refetchInterval: false,
    staleTime: 5000,
  });
  
  const effectiveProjectId = threadQuery.data?.project_id || projectId || '';
  const hasThreadData = !!threadQuery.data;
  const projectQuery = useProjectQuery(effectiveProjectId, {
    enabled: hasThreadData && !!effectiveProjectId,
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
    staleTime: 10000,
  });
  
  const shouldPollAgentRuns = waitingForAgent && !foundRunningAgentRef.current && !agentRunId;
  
  const agentRunsQuery = useAgentRunsQuery(threadId, { 
    enabled: !isShared,
    refetchInterval: shouldPollAgentRuns ? 2000 : false,
    staleTime: 1000,
  });

  const project = projectQuery.data || null;
  const sandboxId = project?.sandbox?.id || (typeof project?.sandbox === 'string' ? project.sandbox : null);
  const projectName = project?.name || '';

  useEffect(() => {
    messagesLoadedRef.current = false;
    foundRunningAgentRef.current = false;
    lastDetectedRunIdRef.current = null;
    initialLoadCompleted.current = false;
    hasInitiallyScrolled.current = false;
    retryCountRef.current = 0;
    setMessages([]);
    setAgentRunId(null);
    setAgentStatus('idle');
  }, [threadId]);

  const hasInitializedFromPreconnect = useRef(false);
  
  useEffect(() => {
    if (hasInitializedFromPreconnect.current || isShared || agentRunId) {
      return;
    }

    const checkForAgentRunId = () => {
      try {
        const storedAgentRunId = sessionStorage.getItem('optimistic_agent_run_id');
        const storedAgentRunThread = sessionStorage.getItem('optimistic_agent_run_thread');
        
        if (storedAgentRunId && storedAgentRunThread === threadId) {
          console.log('[useThreadData] Using pre-stored agent_run_id:', storedAgentRunId);
          foundRunningAgentRef.current = true;
          lastDetectedRunIdRef.current = storedAgentRunId;
          hasInitializedFromPreconnect.current = true;
          
          setAgentRunId(storedAgentRunId);
          setAgentStatus('running');
          
          sessionStorage.removeItem('optimistic_agent_run_id');
          sessionStorage.removeItem('optimistic_agent_run_thread');
          return true;
        }
      } catch (e) {
      }

      try {
        const preconnectService = getStreamPreconnectService();
        const preconnectAgentRunId = preconnectService.getAgentRunIdForThread(threadId);
        
        if (preconnectAgentRunId) {
          console.log('[useThreadData] Found agent_run_id from StreamPreconnect:', preconnectAgentRunId);
          foundRunningAgentRef.current = true;
          lastDetectedRunIdRef.current = preconnectAgentRunId;
          hasInitializedFromPreconnect.current = true;
          
          setAgentRunId(preconnectAgentRunId);
          setAgentStatus('running');
          return true;
        }
      } catch (e) {
      }

      return false;
    };

    if (checkForAgentRunId()) {
      return;
    }

    let pollCount = 0;
    const maxPolls = 40;
    
    const pollInterval = setInterval(() => {
      pollCount++;
      if (checkForAgentRunId() || pollCount >= maxPolls) {
        clearInterval(pollInterval);
      }
    }, 50);

    return () => clearInterval(pollInterval);
  }, [isShared, threadId, agentRunId]);

  useEffect(() => {
    if (!waitingForAgent || isShared || foundRunningAgentRef.current || agentRunId || hasInitializedFromPreconnect.current) {
      return;
    }

    const getRetryDelay = (count: number): number => {
      if (count < 3) return 500;
      if (count < 6) return 1000;
      if (count < 10) return 2000;
      return 3000;
    };

    const retryTimeout = setTimeout(() => {
      try {
        const storedAgentRunId = sessionStorage.getItem('optimistic_agent_run_id');
        const storedAgentRunThread = sessionStorage.getItem('optimistic_agent_run_thread');
        
        if (storedAgentRunId && storedAgentRunThread === threadId) {
          console.log('[useThreadData] Found agent_run_id in sessionStorage during retry:', storedAgentRunId);
          foundRunningAgentRef.current = true;
          lastDetectedRunIdRef.current = storedAgentRunId;
          setAgentRunId(storedAgentRunId);
          setAgentStatus('running');
          sessionStorage.removeItem('optimistic_agent_run_id');
          sessionStorage.removeItem('optimistic_agent_run_thread');
          return;
        }
      } catch (e) {
      }
      
      if (!foundRunningAgentRef.current && !agentRunId) {
        retryCountRef.current += 1;
        if (process.env.NODE_ENV !== 'production') {
          console.log('[useThreadData] Retry polling for agent runs, attempt:', retryCountRef.current);
        }
        agentRunsQuery.refetch();
      }
    }, getRetryDelay(retryCountRef.current));

    return () => clearTimeout(retryTimeout);
  }, [waitingForAgent, isShared, agentRunId, agentRunsQuery, agentRunsQuery.dataUpdatedAt, threadId]);

  useEffect(() => {
    if (isShared || !agentRunsQuery.data) return;
    if (process.env.NODE_ENV !== 'production' && waitingForAgent && agentRunsQuery.data.length > 0) {
      console.log('[useThreadData] Agent runs data:', agentRunsQuery.data.map(r => ({ id: r.id, status: r.status })));
    }
    
    const runningRuns = agentRunsQuery.data.filter(r => r.status === 'running');
    
    if (runningRuns.length > 0) {
      const latestRunning = runningRuns[0];
      
      if (lastDetectedRunIdRef.current !== latestRunning.id) {
        console.log('[useThreadData] Detected running agent:', latestRunning.id);
        lastDetectedRunIdRef.current = latestRunning.id;
        foundRunningAgentRef.current = true;
        retryCountRef.current = 0;
        setAgentRunId(latestRunning.id);
        setAgentStatus('running');
      }
    } else if (foundRunningAgentRef.current && !waitingForAgent) {
      setAgentStatus('idle');
      setAgentRunId(null);
      lastDetectedRunIdRef.current = null;
    }
  }, [agentRunsQuery.data, isShared, waitingForAgent]);

  useEffect(() => {
    let isMounted = true;

    async function initializeData() {
      if (!initialLoadCompleted.current) setIsLoading(true);
      setError(null);
      try {
        if (!threadId) throw new Error('Thread ID is required');

        if (threadQuery.isError) {
          const errorMessage = String(threadQuery.error);
          const isThreadNotFound = errorMessage.includes('Thread not found') || errorMessage.includes('404');

          if (!isThreadNotFound) {
            throw new Error('Failed to load thread data: ' + threadQuery.error);
          }
        }
        if (!isMounted) return;

        if (messagesQuery.data && !messagesLoadedRef.current) {
          const unifiedMessages = (messagesQuery.data || [])
            .map((msg: ApiMessageType) => ({
              message_id: msg.message_id || null,
              thread_id: msg.thread_id || threadId,
              type: (msg.type || 'system') as UnifiedMessage['type'],
              is_llm_message: Boolean(msg.is_llm_message),
              content: msg.content || '',
              metadata: msg.metadata || '{}',
              created_at: msg.created_at || new Date().toISOString(),
              updated_at: msg.updated_at || new Date().toISOString(),
              agent_id: (msg as any).agent_id,
              agents: (msg as any).agents,
            }));

          const serverIds = new Set(
            unifiedMessages.map((m) => m.message_id).filter(Boolean) as string[],
          );
          const localExtras = (messages || []).filter(
            (m) =>
              !m.message_id ||
              (typeof m.message_id === 'string' && m.message_id.startsWith('temp-')) ||
              !serverIds.has(m.message_id as string),
          );
          const mergedMessages = [...unifiedMessages, ...localExtras].sort((a, b) => {
            const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
            const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
            return aTime - bTime;
          });

          // Deduplicate by message_id and content fingerprint
          const dedupedMessages: UnifiedMessage[] = [];
          const seenIds = new Set<string>();
          const seenFingerprints = new Set<string>();

          // First pass: collect content from server-confirmed user messages (non-temp IDs)
          const serverUserContents = new Set<string>();
          mergedMessages.forEach((msg) => {
            if (msg.type === 'user' && msg.message_id && !msg.message_id.startsWith('temp-')) {
              const contentKey = extractUserMessageText(msg.content).trim().toLowerCase();
              if (contentKey) serverUserContents.add(contentKey);
            }
          });

          // Second pass: build deduped list
          // Only deduplicate temp messages when server version exists
          // Server-confirmed messages with different IDs are kept (intentional duplicates)
          mergedMessages.forEach((msg) => {
            const msgId = msg.message_id;
            // Skip if we've already seen this exact message ID
            if (msgId && seenIds.has(msgId)) return;

            // For user messages: only deduplicate temp messages
            if (msg.type === 'user') {
              const isTemp = msgId?.startsWith('temp-');
              const contentKey = extractUserMessageText(msg.content).trim().toLowerCase();

              if (isTemp && contentKey) {
                const tempCreatedAt = msg.created_at ? new Date(msg.created_at).getTime() : Date.now();

                // Find if there's a matching server message created at similar time
                const hasMatchingServerVersion = mergedMessages.some((existing) => {
                  if (existing.type !== 'user') return false;
                  if (existing.message_id?.startsWith('temp-')) return false;
                  if (extractUserMessageText(existing.content).trim().toLowerCase() !== contentKey) return false;

                  const serverCreatedAt = existing.created_at ? new Date(existing.created_at).getTime() : 0;
                  return Math.abs(serverCreatedAt - tempCreatedAt) < 30000;
                });

                if (hasMatchingServerVersion) return;
              }

              // For temp messages, also check if we already added a temp with same content
              if (isTemp && contentKey) {
                const alreadyHasTempWithContent = dedupedMessages.some(
                  (m) => m.type === 'user' &&
                    m.message_id?.startsWith('temp-') &&
                    extractUserMessageText(m.content).trim().toLowerCase() === contentKey
                );
                if (alreadyHasTempWithContent) return;
              }
            }

            // For assistant/tool: use fingerprint to avoid duplicates from race conditions
            if ((msg.type === 'assistant' || msg.type === 'tool') && msg.content) {
              const createdTime = msg.created_at ? new Date(msg.created_at).getTime() : 0;
              const roundedTime = Math.floor(createdTime / 1000);
              const fingerprint = `${msg.type}:${roundedTime}:${String(msg.content).substring(0, 200)}`;
              if (seenFingerprints.has(fingerprint)) return;
              seenFingerprints.add(fingerprint);
            }

            dedupedMessages.push(msg);
            if (msgId) seenIds.add(msgId);
          });

          setMessages(dedupedMessages);
          messagesLoadedRef.current = true;

          if (!hasInitiallyScrolled.current) {
            hasInitiallyScrolled.current = true;
          }
        }
        const isThreadNotFound = threadQuery.isError &&
          (String(threadQuery.error).includes('Thread not found') || String(threadQuery.error).includes('404'));
        const requiredDataLoaded = Boolean((threadQuery.data || isThreadNotFound) && messagesQuery.data !== undefined);

        if (requiredDataLoaded) {
          initialLoadCompleted.current = true;
          setIsLoading(false);
        }

      } catch (err) {
        console.error('Error loading thread data:', err);
        if (isMounted) {
          const errorMessage =
            err instanceof Error ? err.message : 'Failed to load thread';
          const is404Error = errorMessage.toLowerCase().includes('404') || 
                            errorMessage.toLowerCase().includes('not found');
          if (!is404Error) {
            setError(errorMessage);
            toast.error(errorMessage);
          }
          setIsLoading(false);
        }
      }
    }

    if (threadId) {
      initializeData();
    }

    return () => {
      isMounted = false;
    };
  }, [
    threadId,
    threadQuery.data,
    threadQuery.isError,
    threadQuery.error,
    projectQuery.data,
    messagesQuery.data,
    agentRunsQuery.data,
    isShared,
    // Note: 'messages' was removed from deps to prevent infinite loops
    // The effect is guarded by messagesLoadedRef.current anyway
  ]);

  // Merge server data with local state when query data updates
  // This ensures reasoning_content and other metadata updates from server are reflected
  useEffect(() => {
    if (messagesQuery.data && messagesQuery.status === 'success' && !isLoading) {
      const unifiedMessages = (messagesQuery.data || [])
        .map((msg: ApiMessageType) => ({
          message_id: msg.message_id || null,
          thread_id: msg.thread_id || threadId,
          type: (msg.type || 'system') as UnifiedMessage['type'],
          is_llm_message: Boolean(msg.is_llm_message),
          content: msg.content || '',
          metadata: msg.metadata || '{}',
          created_at: msg.created_at || new Date().toISOString(),
          updated_at: msg.updated_at || new Date().toISOString(),
          agent_id: (msg as any).agent_id,
          agents: (msg as any).agents,
        }));

      setMessages((prev) => {
        // Create a map of server messages by ID for quick lookup
        const serverMessageMap = new Map(
          unifiedMessages
            .filter((m) => m.message_id)
            .map((m) => [m.message_id, m])
        );

        // Merge: use server version for existing messages (to get updated metadata),
        // keep local-only messages (temp IDs or not in server response)
        const merged: UnifiedMessage[] = [];
        const processedIds = new Set<string | null>();
        const skippedDuplicates: string[] = [];

        // First, process local messages - replace with server version if available
        (prev || []).forEach((localMsg) => {
          const msgId = localMsg.message_id;

          // Skip if we've already processed this message ID (prevents duplicates)
          if (msgId && processedIds.has(msgId)) {
            skippedDuplicates.push(msgId.slice(-8));
            return;
          }

          if (msgId && serverMessageMap.has(msgId)) {
            // Use server version (has updated metadata like reasoning_content)
            merged.push(serverMessageMap.get(msgId)!);
            processedIds.add(msgId);
          } else if (
            !msgId ||
            (typeof msgId === 'string' && msgId.startsWith('temp-'))
          ) {
            // Keep local-only messages (temp IDs or no ID)
            merged.push(localMsg);
            if (msgId) processedIds.add(msgId);
          } else {
            // Keep local messages with real IDs that aren't in server response yet
            // (might be recently added via streaming)
            merged.push(localMsg);
            if (msgId) processedIds.add(msgId);
          }
        });

        // Add any server messages not in local state (new messages from refetch)
        let addedFromServer = 0;
        unifiedMessages.forEach((serverMsg) => {
          if (serverMsg.message_id && !processedIds.has(serverMsg.message_id)) {
            merged.push(serverMsg);
            processedIds.add(serverMsg.message_id);
            addedFromServer++;
          }
        });

        // Sort by created_at
        merged.sort((a, b) => {
          const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
          return aTime - bTime;
        });

        // Final deduplication pass - ensure no duplicate message_ids
        // Also deduplicate temp user messages that have been confirmed by server
        const finalDeduped: UnifiedMessage[] = [];
        const seenIds = new Set<string>();

        // Track content fingerprints to catch duplicates even with different IDs
        // This handles race conditions where same message might appear twice
        const seenContentFingerprints = new Set<string>();

        // First pass: collect content from server-confirmed user messages (non-temp IDs)
        // This allows us to filter out temp messages that have been confirmed by server
        const serverUserContents = new Set<string>();
        merged.forEach((msg) => {
          if (msg.type === 'user' && msg.message_id && !msg.message_id.startsWith('temp-')) {
            // Use extractUserMessageText to properly parse JSON content
            const contentKey = extractUserMessageText(msg.content).trim().toLowerCase();
            if (contentKey) serverUserContents.add(contentKey);
          }
        });

        // Second pass: build deduped list
        merged.forEach((msg) => {
          const msgId = msg.message_id;

          // Check for duplicate by message_id
          if (msgId && seenIds.has(msgId)) {
            return;
          }

          // For temp user messages, skip if server already confirmed a message with same content
          // This handles the race where both temp and server versions appear
          // Uses timestamp-aware deduplication: only skip if server message was created within 30 seconds
          // This allows intentionally repeated messages (different turns) while preventing duplicates
          if (msg.type === 'user' && msgId?.startsWith('temp-')) {
            // Use extractUserMessageText to properly parse JSON content
            const contentKey = extractUserMessageText(msg.content).trim().toLowerCase();
            if (contentKey) {
              const tempCreatedAt = msg.created_at ? new Date(msg.created_at).getTime() : Date.now();

              const hasMatchingServerVersion = merged.some((existing) => {
                if (existing.type !== 'user') return false;
                if (existing.message_id?.startsWith('temp-')) return false;
                if (extractUserMessageText(existing.content).trim().toLowerCase() !== contentKey) return false;

                const serverCreatedAt = existing.created_at ? new Date(existing.created_at).getTime() : 0;
                return Math.abs(serverCreatedAt - tempCreatedAt) < 30000;
              });

              if (hasMatchingServerVersion) return;
            }
          }

          // Content fingerprint check ONLY for temp messages to catch duplicates
          // Server-confirmed messages (non-temp IDs) are ALWAYS preserved - this allows
          // intentionally repeated messages (user sent same text multiple times)
          // NOTE: We intentionally do NOT include timestamp in fingerprint because
          // race conditions can cause same message to arrive with slightly different timestamps
          const isTemp = msgId?.startsWith('temp-');
          if (isTemp && msg.content) {
            // For user messages, use extractUserMessageText to properly parse JSON content
            const contentKey = msg.type === 'user'
              ? extractUserMessageText(msg.content).trim().toLowerCase().substring(0, 200)
              : String(msg.content).trim().substring(0, 200);
            const fingerprint = `${msg.type}:${contentKey}`;

            if (seenContentFingerprints.has(fingerprint)) {
              return;
            }
            seenContentFingerprints.add(fingerprint);
          }

          finalDeduped.push(msg);
          if (msgId) seenIds.add(msgId);
        });

        return finalDeduped;
      });
    }
  }, [messagesQuery.data, messagesQuery.status, isLoading, threadId]);

  return {
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
    initialLoadCompleted: initialLoadCompleted.current,
    threadQuery,
    messagesQuery,
    projectQuery,
    agentRunsQuery,
  };
} 
