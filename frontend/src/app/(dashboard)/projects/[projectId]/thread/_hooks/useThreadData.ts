import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Project } from '@/lib/api';
import { useThreadQuery } from '@/hooks/react-query/threads/use-threads';
import { useMessagesQuery } from '@/hooks/react-query/threads/use-messages';
import { useProjectQuery } from '@/hooks/react-query/threads/use-project';
import { useAgentRunsQuery } from '@/hooks/react-query/threads/use-agent-run';
import { ApiMessageType, UnifiedMessage, AgentStatus } from '../_types';

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

export function useThreadData(threadId: string, projectId: string): UseThreadDataReturn {
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const initialLoadCompleted = useRef<boolean>(false);
  const messagesLoadedRef = useRef(false);
  const agentRunsCheckedRef = useRef(false);
  const hasInitiallyScrolled = useRef<boolean>(false);
  

  const threadQuery = useThreadQuery(threadId);
  const messagesQuery = useMessagesQuery(threadId);
  const projectQuery = useProjectQuery(projectId);
  const agentRunsQuery = useAgentRunsQuery(threadId);
  
  // (debug logs removed)

  useEffect(() => {
    let isMounted = true;
    
    // Reset refs when thread changes
    agentRunsCheckedRef.current = false;
    messagesLoadedRef.current = false;
    initialLoadCompleted.current = false;
    
    // Clear messages on thread change; fresh data will set messages
    setMessages([]);

    async function initializeData() {
      if (!initialLoadCompleted.current) setIsLoading(true);
      setError(null);
      try {
        if (!threadId) throw new Error('Thread ID is required');

        if (threadQuery.isError) {
          throw new Error('Failed to load thread data: ' + threadQuery.error);
        }
        if (!isMounted) return;

        if (projectQuery.data) {
          setProject(projectQuery.data);
          if (typeof projectQuery.data.sandbox === 'string') {
            setSandboxId(projectQuery.data.sandbox);
          } else if (projectQuery.data.sandbox?.id) {
            setSandboxId(projectQuery.data.sandbox.id);
          }

          setProjectName(projectQuery.data.name || '');
        }

        if (messagesQuery.data && !messagesLoadedRef.current) {
          // (debug logs removed)

          const unifiedMessages = (messagesQuery.data || [])
            .filter((msg) => msg.type !== 'status')
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
          // Messages set only from server merge; no cross-thread cache
          messagesLoadedRef.current = true;

          if (!hasInitiallyScrolled.current) {
            hasInitiallyScrolled.current = true;
          }
        }

        if (agentRunsQuery.data && !agentRunsCheckedRef.current && isMounted) {
          // (debug logs removed)
          
          agentRunsCheckedRef.current = true;
          
          // Check for any running agents - no time restrictions!
          const runningRuns = agentRunsQuery.data.filter(r => r.status === 'running');
          if (runningRuns.length > 0) {
            const latestRunning = runningRuns[0]; // Use first running agent
            setAgentRunId(latestRunning.id);
            setAgentStatus('running');
          } else {
            setAgentStatus('idle');
            setAgentRunId(null);
          }
        }

        if (threadQuery.data && messagesQuery.data && agentRunsQuery.data) {
          initialLoadCompleted.current = true;
          setIsLoading(false);
          // Removed time-based final check to avoid incorrectly forcing idle while a stream is active
        }

      } catch (err) {
        console.error('Error loading thread data:', err);
        if (isMounted) {
          const errorMessage =
            err instanceof Error ? err.message : 'Failed to load thread';
          setError(errorMessage);
          toast.error(errorMessage);
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
    agentRunsQuery.data
  ]);

  // Force message reload when thread changes or new data arrives
  useEffect(() => {
    if (messagesQuery.data && messagesQuery.status === 'success' && !isLoading) {
      // (debug logs removed)
      
      // Always reload messages when thread data changes or we have more raw messages than processed
      const shouldReload = messages.length === 0 || messagesQuery.data.length > messages.length + 50; // Allow for status messages
      
      if (shouldReload) {
        // (debug logs removed)
        
        const unifiedMessages = (messagesQuery.data || [])
          .filter((msg) => msg.type !== 'status')
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
