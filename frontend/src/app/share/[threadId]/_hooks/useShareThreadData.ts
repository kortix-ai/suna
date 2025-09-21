import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  getMessages,
  getProject,
  getThread,
  Project,
  Message as BaseApiMessageType,
} from '@/lib/api';
import {
  UnifiedMessage,
  ParsedMetadata,
} from '@/components/thread/types';

// Error code mappings for share page
const threadErrorCodeMessages: Record<string, string> = {
  PGRST116: 'The requested chat does not exist, has been deleted, or you do not have access to it.',
};

interface ApiMessageType extends BaseApiMessageType {
  message_id?: string;
  thread_id?: string;
  is_llm_message?: boolean;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
  agent_id?: string;
  agents?: {
    name: string;
    profile_image_url?: string;
    icon_name?: string;
    icon_color?: string;
    icon_background?: string;
  };
}

type AgentStatus = 'idle' | 'running' | 'connecting' | 'error';

interface UseShareThreadDataReturn {
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
}

export function useShareThreadData(threadId: string): UseShareThreadDataReturn {
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const initialLoadCompleted = useRef<boolean>(false);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      if (!initialLoadCompleted.current) setIsLoading(true);
      setError(null);

      try {
        if (!threadId) throw new Error('Thread ID is required');

        const [threadData, messagesData] = await Promise.all([
          getThread(threadId).catch((err) => {
            if (threadErrorCodeMessages[err.code]) {
              setError(threadErrorCodeMessages[err.code]);
            } else {
              throw new Error(err.message);
            }
            return null;
          }),
          getMessages(threadId).catch((err) => {
            console.warn('Failed to load messages:', err);
            return [];
          }),
        ]);

        if (!isMounted) return;

        const projectData = threadData?.project_id
          ? await getProject(threadData.project_id).catch((err) => {
            console.warn('[SHARE] Could not load project data:', err);
            return null;
          })
          : null;

        if (isMounted) {
          if (projectData) {
            setProject(projectData);
            if (typeof projectData.sandbox === 'string') {
              setSandboxId(projectData.sandbox);
            } else if (projectData.sandbox?.id) {
              setSandboxId(projectData.sandbox.id);
            }

            setProjectName(projectData.name || '');
          } else {
            setProjectName('Shared Conversation');
          }

          const unifiedMessages = (messagesData || [])
            .filter((msg) => msg.type !== 'status')
            .map((msg: ApiMessageType) => {
              let finalContent: string | object = msg.content || '';
              if (msg.metadata) {
                try {
                  const metadata = JSON.parse(msg.metadata);
                  if (metadata.frontend_content) {
                    finalContent = metadata.frontend_content;
                  }
                } catch (e) {
                  // ignore
                }
              }
              return {
                message_id: msg.message_id || null,
                thread_id: msg.thread_id || threadId,
                type: (msg.type || 'system') as UnifiedMessage['type'],
                is_llm_message: Boolean(msg.is_llm_message),
                content: typeof finalContent === 'string' ? finalContent : JSON.stringify(finalContent),
                metadata: msg.metadata || '{}',
                created_at: msg.created_at || new Date().toISOString(),
                updated_at: msg.updated_at || new Date().toISOString(),
                agent_id: (msg as any).agent_id,
                agents: (msg as any).agents,
              };
            });

          setMessages(unifiedMessages);
          initialLoadCompleted.current = true;
        }
      } catch (err) {
        console.error('Error loading thread data:', err);
        if (isMounted) {
          const errorMessage =
            err instanceof Error ? err.message : 'Failed to load thread';
          setError(errorMessage);
          toast.error(errorMessage);
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    
    loadData();
    return () => {
      isMounted = false;
    };
  }, [threadId]);

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
  };
}
