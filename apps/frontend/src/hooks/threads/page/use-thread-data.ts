import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { Project } from '@/lib/api/threads';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import { useMessagesQuery } from '@/hooks/messages';
import { useProjectQuery } from '@/hooks/threads/use-project';
import { useAgentRunsQuery } from '@/hooks/threads/use-agent-run';
import { ApiMessageType, UnifiedMessage, AgentStatus } from '@/components/thread/types';
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

          setMessages(mergedMessages);
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
    messages
  ]);

  useEffect(() => {
    if (messagesQuery.data && messagesQuery.status === 'success' && !isLoading) {
      const shouldReload = messages.length === 0 || messagesQuery.data.length > messages.length + 50;
      
      if (shouldReload) {
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
          const serverIds = new Set(
            unifiedMessages.map((m) => m.message_id).filter(Boolean) as string[],
          );
          const localExtras = (prev || []).filter(
            (m) =>
              !m.message_id ||
              (typeof m.message_id === 'string' && m.message_id.startsWith('temp-')) ||
              !serverIds.has(m.message_id as string),
          );
          const merged = [...unifiedMessages, ...localExtras].sort((a, b) => {
            const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
            const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
            return aTime - bTime;
          });
          
          return merged;
        });
      }
    }
  }, [messagesQuery.data, messagesQuery.status, isLoading, messages.length, threadId]);

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
