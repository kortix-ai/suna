import { useQueryClient } from '@tanstack/react-query';
import {
  streamAgent,
  getAgentStatus,
  stopAgent,
} from '@/lib/api/agents';
import { toast } from '@/lib/toast';
import { useMemo } from 'react';
import {
  UnifiedMessage,
} from '@/components/thread/types';
import {
  type TextChunk,
  useAgentStreamCore,
  type StreamConfig,
  type UseAgentStreamCoreCallbacks,
} from '@agentpress/shared/streaming';
import { agentKeys } from '@/hooks/agents/keys';
import { composioKeys } from '@/hooks/composio/keys';
import { knowledgeBaseKeys } from '@/hooks/knowledge-base/keys';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';
import { threadKeys } from '@/hooks/threads/keys';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { accountStateKeys } from '@/hooks/billing';
import { clearToolTracking } from './tool-tracking';
import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Define the structure returned by the hook
export interface UseAgentStreamResult {
  status: string;
  textContent: string; // String for compatibility with existing components
  reasoningContent: string; // Accumulated reasoning content
  toolCall: UnifiedMessage | null; // UnifiedMessage with metadata.tool_calls
  error: string | null;
  agentRunId: string | null;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
}

export interface ToolOutputStreamData {
  tool_call_id: string;
  tool_name: string;
  output: string;
  is_final: boolean;
}

// Define the callbacks the hook consumer can provide
export interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
  onToolOutputStream?: (data: ToolOutputStreamData) => void;
}

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  agentId?: string,
): UseAgentStreamResult {
  const queryClient = useQueryClient();

  // Build query keys array for invalidation
  const queryKeys: (string | readonly string[])[] = [
    fileQueryKeys.all,
    ['active-agent-runs'],
    accountStateKeys.all,
    threadKeys.messages(threadId),
  ];

  if (agentId) {
    queryKeys.push(
      agentKeys.all,
      agentKeys.detail(agentId),
      agentKeys.lists(),
      agentKeys.details(),
      ['agent-tools', agentId],
      ['agent-tools'],
      ['custom-mcp-tools', agentId],
      ['custom-mcp-tools'],
      composioKeys.mcpServers(),
      composioKeys.profiles.all(),
      composioKeys.profiles.credentials(),
      ['triggers', agentId],
      ['triggers'],
      knowledgeBaseKeys.agent(agentId),
      knowledgeBaseKeys.all,
      ['versions'],
      ['versions', 'list'],
      ['versions', 'list', agentId],
      ['versions', 'detail'],
      ['version-store'],
    );
  }

  // Create simplified config - core hook handles EventSource creation
  const config: StreamConfig = {
    apiUrl: API_URL || '',
    getAuthToken: async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      return session?.access_token || null;
    },
    createEventSource: (url: string) => new EventSource(url),
    queryKeys,
    handleBillingError: (errorMessage: string, balance?: string | null) => {
      const messageLower = errorMessage.toLowerCase();
      const isCreditsExhausted = 
        messageLower.includes('insufficient credits') ||
        messageLower.includes('out of credits') ||
        messageLower.includes('no credits') ||
        messageLower.includes('balance');
      
      const alertTitle = isCreditsExhausted 
        ? 'You ran out of credits'
        : 'Billing check failed';
      
      const alertSubtitle = balance 
        ? `Your current balance is ${balance} credits. Upgrade your plan to continue.`
        : isCreditsExhausted 
          ? 'Upgrade your plan to get more credits and continue using the AI assistant.'
          : 'Please upgrade to continue.';
      
      usePricingModalStore.getState().openPricingModal({ 
        isAlert: true, 
        alertTitle,
        alertSubtitle
      });
    },
    showToast: (message: string, type?: 'error' | 'success' | 'warning') => {
      if (type === 'error') {
        toast.error(message, { duration: 15000 });
      } else if (type === 'success') {
        toast.success(message);
      } else if (type === 'warning') {
        toast.warning(message);
      } else {
        toast(message);
      }
    },
    clearToolTracking: () => {
      clearToolTracking();
    },
  };

  // Map callbacks to core callbacks
  const coreCallbacks: UseAgentStreamCoreCallbacks = {
    onMessage: callbacks.onMessage,
    onStatusChange: callbacks.onStatusChange,
    onError: callbacks.onError,
    onClose: callbacks.onClose,
    onAssistantStart: callbacks.onAssistantStart,
    onAssistantChunk: callbacks.onAssistantChunk,
    onToolCallChunk: callbacks.onToolCallChunk,
    onToolOutputStream: callbacks.onToolOutputStream,
  };

  // Use the core hook - immediate mode for real-time streaming without delay
  const coreResult = useAgentStreamCore(
    config,
    coreCallbacks,
    threadId,
    setMessages,
    queryClient,
    { type: 'immediate' } // Immediate updates for real-time streaming
  );

  // Convert TextChunk[] to string for compatibility with existing components
  const textContentString = useMemo(() => {
    if (!coreResult.textContent || coreResult.textContent.length === 0) return '';
    return coreResult.textContent.map(chunk => chunk.content).join('');
  }, [coreResult.textContent]);

  return {
    status: coreResult.status,
    textContent: textContentString,
    reasoningContent: coreResult.reasoningContent || '',
    toolCall: coreResult.toolCall,
    error: coreResult.error,
    agentRunId: coreResult.agentRunId,
    startStreaming: coreResult.startStreaming,
    stopStreaming: coreResult.stopStreaming,
  };
}
