import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { Project } from '@/lib/api/threads';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import { useMessagesQuery } from '@/hooks/messages';
import { useProjectQuery } from '@/hooks/threads/use-project';
import { useAgentRunsQuery } from '@/hooks/threads/use-agent-run';
import { ApiMessageType, UnifiedMessage, AgentStatus } from '@/components/thread/types';

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
  /** Enable polling for agent detection (new threads waiting for optimistic start) */
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
  
  // Retry counter for exponential backoff when waiting for agent
  const retryCountRef = useRef(0);

  const threadQuery = useThreadQuery(threadId);
  
  // Messages: NO polling - stream will provide real-time updates
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
  
  // Agent runs: Smart polling only when waiting for agent, stops once found
  const shouldPollAgentRuns = waitingForAgent && !foundRunningAgentRef.current && !agentRunId;
  
  const agentRunsQuery = useAgentRunsQuery(threadId, { 
    enabled: !isShared,
    // Only poll when actively waiting for an agent to start
    // Use 2s interval - fast enough for good UX, not too aggressive
    refetchInterval: shouldPollAgentRuns ? 2000 : false,
    staleTime: 1000,
  });

  const project = projectQuery.data || null;
  const sandboxId = project?.sandbox?.id || (typeof project?.sandbox === 'string' ? project.sandbox : null);
  const projectName = project?.name || '';

  // Reset refs when thread changes
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

  // Check for pre-stored agent_run_id from optimistic start (eliminates polling)
  useEffect(() => {
    if (!waitingForAgent || isShared || foundRunningAgentRef.current || agentRunId) {
      return;
    }

    try {
      const storedAgentRunId = sessionStorage.getItem('optimistic_agent_run_id');
      const storedAgentRunThread = sessionStorage.getItem('optimistic_agent_run_thread');
      
      if (storedAgentRunId && storedAgentRunThread === threadId) {
        console.log('[useThreadData] Using pre-stored agent_run_id:', storedAgentRunId);
        foundRunningAgentRef.current = true;
        lastDetectedRunIdRef.current = storedAgentRunId;
        setAgentRunId(storedAgentRunId);
        setAgentStatus('running');
        
        // Clean up sessionStorage
        sessionStorage.removeItem('optimistic_agent_run_id');
        sessionStorage.removeItem('optimistic_agent_run_thread');
        return;
      }
    } catch (e) {
      // sessionStorage not available
    }
  }, [waitingForAgent, isShared, agentRunId, threadId]);

  // Manual retry with exponential backoff for agent detection (fallback if sessionStorage doesn't have it yet)
  // This is more efficient than constant polling
  useEffect(() => {
    if (!waitingForAgent || isShared || foundRunningAgentRef.current || agentRunId) {
      return;
    }

    // Quick initial retries, then slow down
    const getRetryDelay = (count: number): number => {
      if (count < 3) return 500;   // First 3: every 500ms
      if (count < 6) return 1000;  // Next 3: every 1s
      if (count < 10) return 2000; // Next 4: every 2s
      return 3000;                 // After that: every 3s
    };

    const retryTimeout = setTimeout(() => {
      // Double-check sessionStorage before polling
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
        // sessionStorage not available
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

  // Detect running agent from query data
  useEffect(() => {
    if (isShared || !agentRunsQuery.data) return;
    
    // Debug logging for agent runs
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
        retryCountRef.current = 0; // Reset retry counter
        setAgentRunId(latestRunning.id);
        setAgentStatus('running');
      }
    } else if (foundRunningAgentRef.current && !waitingForAgent) {
      // Only reset if not actively waiting for agent
      setAgentStatus('idle');
      setAgentRunId(null);
      lastDetectedRunIdRef.current = null;
    }
  }, [agentRunsQuery.data, isShared, waitingForAgent]);

  // Main data initialization effect
  useEffect(() => {
    let isMounted = true;

    async function initializeData() {
      if (!initialLoadCompleted.current) setIsLoading(true);
      setError(null);
      try {
        if (!threadId) throw new Error('Thread ID is required');

        if (threadQuery.isError) {
          throw new Error('Failed to load thread data: ' + threadQuery.error);
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

        // "Initial load" should mean we can render the thread UI (messages + thread metadata).
        // Agent runs are *nice to have* (they can be slow/404 transiently when infra changes),
        // but they should never block the UI from becoming interactive (e.g. opening Kortix Computer).
        const requiredDataLoaded = Boolean(threadQuery.data && messagesQuery.data);
          
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

  // Force message reload when new data arrives (but not via polling)
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
