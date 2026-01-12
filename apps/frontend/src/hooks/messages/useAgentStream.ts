import { useMemo } from 'react';
import type { UnifiedMessage } from '@/components/thread/types';
import { 
  useAgentStream as useAgentStreamNew,
  type ToolOutputStreamData,
} from '@/lib/streaming';
import { toast } from '@/lib/toast';
import { agentKeys } from '@/hooks/agents/keys';
import { composioKeys } from '@/hooks/composio/keys';
import { knowledgeBaseKeys } from '@/hooks/knowledge-base/keys';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';
import { threadKeys } from '@/hooks/threads/keys';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { accountStateKeys } from '@/hooks/billing';
import { clearToolTracking } from './tool-tracking';

export interface UseAgentStreamResult {
  status: string;
  textContent: string;
  reasoningContent: string;
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
}

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

export { ToolOutputStreamData };

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
  agentId?: string,
): UseAgentStreamResult {
  const queryKeys: (string | readonly string[])[] = useMemo(() => {
    const keys: (string | readonly string[])[] = [
      fileQueryKeys.all,
      ['active-agent-runs'],
      accountStateKeys.all,
      threadKeys.messages(threadId),
    ];

    if (agentId) {
      keys.push(
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

    return keys;
  }, [threadId, agentId]);

  const handleBillingError = useMemo(() => (errorMessage: string, balance?: string | null) => {
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
  }, []);

  const showToast = useMemo(() => (message: string, type?: 'error' | 'success' | 'warning') => {
    if (type === 'error') {
      toast.error(message, { duration: 15000 });
    } else if (type === 'success') {
      toast.success(message);
    } else if (type === 'warning') {
      toast.warning(message);
    } else {
      toast(message);
    }
  }, []);

  const result = useAgentStreamNew(
    callbacks,
    threadId,
    setMessages,
    {
      handleBillingError,
      showToast,
      clearToolTracking,
      queryKeys,
    }
  );

  return {
    status: result.status,
    textContent: result.textContent,
    reasoningContent: result.reasoningContent,
    toolCall: result.toolCall as UnifiedMessage | null,
    error: result.error,
    agentRunId: result.agentRunId,
    startStreaming: result.startStreaming,
    stopStreaming: result.stopStreaming,
  };
}
