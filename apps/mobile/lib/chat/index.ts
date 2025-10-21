/**
 * Chat Module
 * 
 * Complete chat/messaging functionality including:
 * - Threads
 * - Messages
 * - Agent runs
 * - SSE streaming
 */

// Re-export everything
export * from './api';
export * from './hooks';

// Named exports for convenience
export { chatKeys } from './hooks';
export {
  useThreads,
  useThread,
  useUpdateThread,
  useDeleteThread,
  useMessages,
  useSendMessage,
  useAgentRuns,
  useAgentRun,
  useInitiateAgent,
  useActiveAgentRuns,
  useAgentRunStatus,
  useStopAgentRun,
} from './hooks';

