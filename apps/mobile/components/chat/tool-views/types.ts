/**
 * Tool View Types
 * 
 * Type definitions for the tool view system
 * Matches frontend structure for consistency
 */

import React from 'react';
import type { UnifiedMessage } from '@/api/types';
import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface ToolViewProps {
  /** Structured tool call data from metadata */
  toolCall: ToolCallData;
  
  /** Structured tool result data from metadata */
  toolResult?: ToolResultData;
  
  /** Assistant message (optional, for some views that need full message context) */
  assistantMessage?: UnifiedMessage | null;
  
  /** Tool message (optional, for some views that need full message context) */
  toolMessage?: UnifiedMessage;
  
  /** Assistant message timestamp */
  assistantTimestamp?: string;
  
  /** Tool message timestamp */
  toolTimestamp?: string;
  
  /** Whether tool execution was successful */
  isSuccess?: boolean;
  
  /** Whether tool is currently executing */
  isStreaming?: boolean;
  
  /** Streaming text content (for partial JSON during streaming) */
  streamingText?: string;
  
  /** Project context (optional) */
  project?: {
    id: string;
    name: string;
    /** Sandbox information */
    sandbox?: {
      id?: string;
      sandbox_url?: string;
      vnc_preview?: string;
      pass?: string;
    };
  };
  
  /** Current index in the tool call list (for determining if this is the latest) */
  currentIndex?: number;
  
  /** Total number of tool calls (for determining if this is the latest) */
  totalCalls?: number;
  
  /** Optional file click handler */
  onFileClick?: (filePath: string) => void;
  
  /** Optional thread ID */
  threadId?: string;
  
  /** Handler to auto-fill chat input with a prompt (for follow-up prompts/answers) */
  onPromptFill?: (prompt: string) => void;
  
  /** Agent status (for browser tool views) */
  agentStatus?: 'idle' | 'running' | 'paused';
  
  /** Messages array (for browser tool views to find browser_state messages) */
  messages?: UnifiedMessage[];
  
  /** View toggle component (for browser tool views) */
  viewToggle?: React.ReactNode;
}

export interface ToolViewComponent {
  (props: ToolViewProps): React.ReactElement | null;
}

