import { useState } from 'react';
import type { UnifiedMessage, StreamingToolCall, StreamingMetadata } from '../types';

export function extractTextFromPartialJson(jsonString: string): string {
  try {
    const parsed = JSON.parse(jsonString);
    return parsed?.content || parsed?.text || '';
  } catch {
    const match = jsonString.match(/"(?:content|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return match ? match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
  }
}

export function isAskOrCompleteTool(functionName: string | undefined): boolean {
  return functionName === 'ask_user' || functionName === 'complete';
}

export function extractTextFromArguments(
  args: string | Record<string, any> | undefined | null
): string {
  if (!args) return '';
  if (typeof args === 'object') return (args as any).text || (args as any).content || '';
  return extractTextFromPartialJson(args);
}

export function findAskOrCompleteTool(
  toolCalls: StreamingToolCall[] | undefined
): StreamingToolCall | undefined {
  return toolCalls?.find(tc => isAskOrCompleteTool(tc.function_name));
}

export function shouldSkipStreamingRender(
  _lastMessageMetadata: StreamingMetadata | undefined
): boolean {
  return false;
}

// ─── TextChunk & ordering ────────────────────────────────────────────────────

export interface TextChunk {
  content: string;
  sequence?: number;
}

// ─── Stream Config & Core Hook ───────────────────────────────────────────────

export interface StreamConfig {
  apiUrl: string;
  getAuthToken: () => Promise<string | null>;
  createEventSource: (url: string) => any;
  queryKeys?: (string | readonly string[])[];
  handleBillingError?: (errorMessage: string, balance?: string | null) => void;
  showToast?: (message: string, type?: 'error' | 'success' | 'warning') => void;
  clearToolTracking?: () => void;
}

export interface UseAgentStreamCoreCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
  onToolOutputStream?: (data: { tool_call_id: string; tool_name: string; output: string; is_final: boolean }) => void;
}

interface UseAgentStreamCoreResult {
  status: string;
  textContent: TextChunk[];
  reasoningContent: string;
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  retryCount: number;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
  resumeStream: () => Promise<void>;
  clearError: () => void;
  setError: (error: string) => void;
}

interface ContentThrottleConfig {
  type: 'immediate' | 'raf' | 'timeout';
  throttleMs?: number;
}

/**
 * Core agent stream hook stub.
 * The actual implementation in the mobile app uses useAgentStream.ts directly,
 * which wraps react-native-sse. This is just a type-compatible stub.
 */
export function useAgentStreamCore(
  _config: StreamConfig,
  _callbacks: UseAgentStreamCoreCallbacks,
  _threadId: string,
  _setMessages: (messages: UnifiedMessage[]) => void,
  _queryClient?: any,
  _throttleConfig?: ContentThrottleConfig,
): UseAgentStreamCoreResult {
  const [status] = useState('idle');
  const [error, setErrorState] = useState<string | null>(null);

  return {
    status,
    textContent: [],
    reasoningContent: '',
    toolCall: null,
    error,
    agentRunId: null,
    retryCount: 0,
    startStreaming: async () => {},
    stopStreaming: async () => {},
    resumeStream: async () => {},
    clearError: () => setErrorState(null),
    setError: (e: string) => setErrorState(e),
  };
}
