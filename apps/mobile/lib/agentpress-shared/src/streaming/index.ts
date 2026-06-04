import { useState, useEffect, useRef, useCallback } from 'react';
import type { UnifiedMessage, StreamingToolCall, StreamingMetadata } from '../types';

// Tool accumulator types
export interface AccumulatedToolCall {
  metadata: { tool_call_id: string; function_name: string; index?: number; [key: string]: any };
  chunks: Array<{ sequence: number; delta: string }>;
}

export interface ReconstructedToolCall {
  tool_call_id: string;
  function_name: string;
  index?: number;
  arguments: string;
  is_delta: boolean;
  completed: boolean;
  tool_result?: any;
}

export interface ToolCallAccumulatorState {
  accumulatedToolCalls: Map<string, AccumulatedToolCall>;
  completedToolCallIds: Set<string>;
  toolResults: Map<string, UnifiedMessage>;
}

export function createAccumulatorState(): ToolCallAccumulatorState {
  return {
    accumulatedToolCalls: new Map(),
    completedToolCallIds: new Set(),
    toolResults: new Map(),
  };
}

export function clearAccumulator(accumulator: ToolCallAccumulatorState): void {
  accumulator.accumulatedToolCalls.clear();
  accumulator.completedToolCallIds.clear();
  accumulator.toolResults.clear();
}

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

export function getAskCompleteToolType(functionName: string | undefined): 'ask' | 'complete' | null {
  if (functionName === 'ask_user') return 'ask';
  if (functionName === 'complete') return 'complete';
  return null;
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
  lastMessageMetadata: StreamingMetadata | undefined
): boolean {
  return false;
}

export function mapAgentStatus(backendStatus: string): string {
  return backendStatus;
}

export function preprocessStreamData(rawData: string): string {
  return rawData;
}

export function isCompletionMessage(processedData: string): boolean {
  try {
    const parsed = JSON.parse(processedData);
    return parsed?.type === 'status' && ['completed', 'stopped', 'failed'].includes(parsed?.status);
  } catch {
    return false;
  }
}

export function parseStreamingMessage(processedData: string): UnifiedMessage | null {
  try {
    return JSON.parse(processedData) as UnifiedMessage;
  } catch {
    return null;
  }
}

// ─── TextChunk & ordering ────────────────────────────────────────────────────

export interface TextChunk {
  content: string;
  sequence?: number;
}

export function orderContentBySequence(chunks: TextChunk[]): string {
  return chunks
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map(c => c.content)
    .join('');
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

export interface UseAgentStreamCoreResult {
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

export interface ContentThrottleConfig {
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
  const [status, setStatus] = useState('idle');
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

// ─── Helper functions used by streaming components ───────────────────────────

export function extractTextFromStreamingAskComplete(content: string, toolName: 'ask' | 'complete'): string {
  return extractTextFromPartialJson(content);
}

export function extractStreamingAskCompleteContent(
  toolCalls: StreamingToolCall[] | undefined
): { toolType: 'ask' | 'complete'; text: string } | null {
  const tool = findAskOrCompleteTool(toolCalls);
  if (!tool) return null;
  const type = getAskCompleteToolType(tool.function_name);
  if (!type) return null;
  return { toolType: type, text: extractTextFromArguments(tool.arguments) };
}

export function extractFieldFromArguments(
  args: string | Record<string, any> | undefined | null,
  field: string
): string {
  if (!args) return '';
  if (typeof args === 'object') return String((args as any)[field] || '');
  try {
    const parsed = JSON.parse(args);
    return String(parsed[field] || '');
  } catch {
    return '';
  }
}

export function accumulateToolCallDeltas(
  toolCalls: StreamingToolCall[],
  sequence: number,
  accumulator: ToolCallAccumulatorState
): void {
  for (const tc of toolCalls) {
    const key = tc.tool_call_id;
    if (!accumulator.accumulatedToolCalls.has(key)) {
      accumulator.accumulatedToolCalls.set(key, {
        metadata: { tool_call_id: tc.tool_call_id, function_name: tc.function_name, index: tc.index },
        chunks: [],
      });
    }
    if (tc.arguments_delta) {
      accumulator.accumulatedToolCalls.get(key)!.chunks.push({
        sequence,
        delta: tc.arguments_delta,
      });
    }
  }
}

export function reconstructToolCalls(accumulator: ToolCallAccumulatorState): ReconstructedToolCall[] {
  const results: ReconstructedToolCall[] = [];
  for (const [id, acc] of accumulator.accumulatedToolCalls) {
    const args = acc.chunks.sort((a, b) => a.sequence - b.sequence).map(c => c.delta).join('');
    results.push({
      tool_call_id: id,
      function_name: acc.metadata.function_name,
      index: acc.metadata.index,
      arguments: args,
      is_delta: false,
      completed: accumulator.completedToolCallIds.has(id),
      tool_result: accumulator.toolResults.get(id),
    });
  }
  return results;
}

export function markToolCallCompleted(
  toolCallId: string,
  resultMessage: UnifiedMessage,
  accumulator: ToolCallAccumulatorState
): void {
  accumulator.completedToolCallIds.add(toolCallId);
  accumulator.toolResults.set(toolCallId, resultMessage);
}

export function handleAssistantChunk(
  message: UnifiedMessage,
  parsedContent: any,
  parsedMetadata: any
): string | null {
  return parsedMetadata?.text_content || parsedContent?.content || null;
}

export function extractReasoningContent(parsedContent: any, parsedMetadata: any): string | null {
  return parsedMetadata?.reasoning_content || parsedContent?.reasoning_content || null;
}

export function handleToolCallChunk(
  message: UnifiedMessage,
  parsedMetadata: any,
  accumulator: ToolCallAccumulatorState
): ReconstructedToolCall[] | null {
  const toolCalls = parsedMetadata?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) return null;
  accumulateToolCallDeltas(toolCalls, message.sequence || 0, accumulator);
  return reconstructToolCalls(accumulator);
}

export function handleToolResult(
  message: UnifiedMessage,
  parsedMetadata: any,
  accumulator: ToolCallAccumulatorState
): ReconstructedToolCall[] | null {
  const toolCallId = parsedMetadata?.tool_call_id;
  if (toolCallId) {
    markToolCallCompleted(toolCallId, message, accumulator);
    return reconstructToolCalls(accumulator);
  }
  return null;
}

export function createMessageWithToolCalls(
  originalMessage: UnifiedMessage,
  parsedMetadata: any,
  reconstructedToolCalls: ReconstructedToolCall[]
): UnifiedMessage {
  return {
    ...originalMessage,
    metadata: JSON.stringify({
      ...(typeof parsedMetadata === 'object' ? parsedMetadata : {}),
      tool_calls: reconstructedToolCalls,
    }),
  };
}
