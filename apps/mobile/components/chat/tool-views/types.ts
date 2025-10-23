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
}

export interface ToolViewComponent {
  (props: ToolViewProps): React.ReactElement | null;
}

