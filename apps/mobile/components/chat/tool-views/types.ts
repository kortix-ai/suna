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
  
  /** Assistant message timestamp */
  assistantTimestamp?: string;
  
  /** Tool message timestamp */
  toolTimestamp?: string;
  
  /** Whether tool execution was successful */
  isSuccess?: boolean;
  
  /** Whether tool is currently executing */
  isStreaming?: boolean;
  
  /** Project context (optional) */
  project?: {
    id: string;
    name: string;
    sandbox_id?: string;
  };
  
  /** Current index in the tool call list (for determining if this is the latest) */
  currentIndex?: number;
  
  /** Total number of tool calls (for determining if this is the latest) */
  totalCalls?: number;
  
  /** Optional file click handler */
  onFileClick?: (filePath: string) => void;
  
  /** Optional thread ID */
  threadId?: string;
}

export interface ToolViewComponent {
  (props: ToolViewProps): React.ReactElement | null;
}

