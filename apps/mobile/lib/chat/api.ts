/**
 * Chat API Client & Types
 * 
 * Core API functions and types for threads, messages, and agent runs
 */

import { API_URL, getAuthToken, getAuthHeaders } from '@/api/config';

// Re-export types from API types
export type {
  Thread,
  Message,
  AgentRun,
  SendMessageInput,
  InitiateAgentInput,
  InitiateAgentResponse,
  ActiveAgentRun,
} from '@/api/types';

