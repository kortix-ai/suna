import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
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
  enablePolling?: boolean;
}

export function useThreadData(
  threadId: string, 
  projectId: string, 
  isShared: boolean = false,
  options?: UseThreadDataOptions
): UseThreadDataReturn {
  const { enablePolling = false } = options || {};
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const initialLoadCompleted = useRef<boolean>(false);
  const messagesLoadedRef = useRef(false);
  // Track if we've found a running agent (not just checked once)
  const foundRunningAgentRef = useRef(false);
  const hasInitiallyScrolled = useRef<boolean>(false);
  // Track the last agent run ID we detected to avoid duplicate updates
  const lastDetectedRunIdRef = useRef<string | null>(null);
  

  const threadQuery = useThreadQuery(threadId);
  const messagesQuery = useMessagesQuery(threadId, {
    // Use faster polling (1s) for new threads to detect agent start quickly
    refetchInterval: enablePolling ? 1000 : false,
    staleTime: 500, // Lower stale time for faster updates during polling
  });
  
  const effectiveProjectId = threadQuery.data?.project_id || projectId || '';
  const hasThreadData = !!threadQuery.data;
  const projectQuery = useProjectQuery(effectiveProjectId, {
    enabled: hasThreadData && !!effectiveProjectId,
    refetchOnWindowFocus: true,
    refetchInterval: 30000, // 30s is enough for project data
    staleTime: 10000,
  });
  
  const agentRunsQuery = useAgentRunsQuery(threadId, { 
    enabled: !isShared,
    // Use faster polling (1s) for new threads to detect agent start quickly
    refetchInterval: enablePolling ? 1000 : false,
    staleTime: 500, // Lower stale time for faster updates during polling
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
    setMessages([]);
    setAgentRunId(null);
    setAgentStatus('idle');
  }, [threadId]);

  // Dedicated effect for continuous agent run monitoring
  // This runs on every agentRunsQuery.data change, not just once
  useEffect(() => {
    if (isShared || !agentRunsQuery.data) return;
    
    const runningRuns = agentRunsQuery.data.filter(r => r.status === 'running');
    
    if (runningRuns.length > 0) {
      const latestRunning = runningRuns[0];
      
      // Only update if this is a new running agent we haven't detected yet
      if (lastDetectedRunIdRef.current !== latestRunning.id) {
        console.log('[useThreadData] Detected running agent:', latestRunning.id);
        lastDetectedRunIdRef.current = latestRunning.id;
        foundRunningAgentRef.current = true;
        setAgentRunId(latestRunning.id);
        setAgentStatus('running');
      }
    } else if (foundRunningAgentRef.current && !enablePolling) {
      // Only reset to idle if we previously found a running agent and polling is disabled
      // This prevents premature idle state during the race condition window
      setAgentStatus('idle');
      setAgentRunId(null);
      lastDetectedRunIdRef.current = null;
    }
  }, [agentRunsQuery.data, isShared, enablePolling]);

  // Trigger immediate agent runs refetch when messages first load (during polling)
  // This helps catch the agent run faster since messages often arrive before agent run is detected
  useEffect(() => {
    if (!enablePolling || isShared || foundRunningAgentRef.current) return;
    
    // When messages arrive for the first time, immediately refetch agent runs
    if (messagesQuery.data && messagesQuery.data.length > 0 && !agentRunId) {
      console.log('[useThreadData] Messages detected, triggering agent runs refetch');
      agentRunsQuery.refetch();
    }
  }, [messagesQuery.data, enablePolling, isShared, agentRunId, agentRunsQuery]);

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
          // Backend now filters out status messages, so no need to filter here
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

          // Merge with any local messages that are not present in server data yet
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

        // For shared pages, only wait for thread and messages data
        const requiredDataLoaded = isShared 
          ? (threadQuery.data && messagesQuery.data)
          : (threadQuery.data && messagesQuery.data && agentRunsQuery.data);
          
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
    isShared
  ]);

  // Force message reload when thread changes or new data arrives
  useEffect(() => {
    if (messagesQuery.data && messagesQuery.status === 'success' && !isLoading) {
      // (debug logs removed)
      
      // Always reload messages when thread data changes or we have more raw messages than processed
      const shouldReload = messages.length === 0 || messagesQuery.data.length > messages.length + 50; // Allow for status messages
      
      if (shouldReload) {
        // (debug logs removed)
        
        // Backend now filters out status messages, so no need to filter here
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

        // Merge strategy: preserve any local (optimistic/streamed) messages not in server yet
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
          
          // Messages set only from server merge; no cross-thread cache
          return merged;
        });
      } else {
        // (debug logs removed)
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
