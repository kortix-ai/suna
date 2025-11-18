/**
 * Tool View Types
 * 
 * Type definitions for the tool view system
 */

import React from 'react';
import type { UnifiedMessage } from '@/api/types';
import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface ToolViewProps {
  /** Parsed tool execution data */
  toolData: ParsedToolData;
  
  /** Assistant message that triggered the tool */
  assistantMessage: UnifiedMessage | null;
  
  /** Tool result message */
  toolMessage: UnifiedMessage;
  
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
}

export interface ToolViewComponent {
  (props: ToolViewProps): React.ReactElement | null;
}

