import React from 'react';
import type { Project } from '@/lib/api';
import { Message as BaseApiMessageType } from '@/lib/api';

// Define a type for the params to make React.use() work properly
export type ThreadParams = {
  threadId: string;
  projectId: string;
};

// Unified Message Interface matching the backend/database schema
export interface UnifiedMessage {
  sequence?: number;
  message_id: string | null; // Can be null for transient stream events (chunks, unsaved statuses)
  thread_id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'status' | 'browser_state' | 'image_context' | 'llm_response_end'; // image_context for images loaded into LLM context
  is_llm_message: boolean;
  content: string; // ALWAYS a JSON string from the backend
  metadata: string; // ALWAYS a JSON string from the backend
  created_at: string; // ISO timestamp string
  updated_at: string; // ISO timestamp string
  agent_id?: string; // ID of the agent associated with this message
  agents?: {
    name: string;
  }; // Agent information from join
}

// Helper type for parsed content - structure depends on message.type
export interface ParsedContent {
  role?: 'user' | 'assistant' | 'tool' | 'system'; // From the JSON string in content
  content?: any; // Can be string, object, etc. after parsing
  tool_calls?: any[]; // For native tool calls
  tool_call_id?: string; // For tool results
  name?: string; // For tool results
  status_type?: string; // For status messages
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  }; // For llm_response_end messages
  [key: string]: any; // Allow other properties
}

// Helper type for parsed metadata
export interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete';
  thread_run_id?: string;
  tool_index?: number;
  assistant_message_id?: string; // Link tool results/statuses back
  linked_tool_result_message_id?: string; // Link status to tool result
  parsing_details?: any;
  [key: string]: any; // Allow other properties
}

// Extend the base Message type with the expected database fields
export interface ApiMessageType extends Omit<BaseApiMessageType, 'type'> {
  message_id?: string;
  thread_id?: string;
  is_llm_message?: boolean;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
  // Allow 'type' to be potentially wider than the base type
  type?: string;
}

// Re-export existing types
export type { Project };
