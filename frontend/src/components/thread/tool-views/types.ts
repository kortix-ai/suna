import { Project } from '@/lib/api/threads';

/**
 * Structured tool call data from metadata
 */
export interface ToolCallData {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, any>;
  source: 'native' | 'xml';
}

/**
 * Structured tool result data from metadata
 */
export interface ToolResultData {
  success: boolean;
  output: any;
  error?: string | null;
}

export interface ToolViewProps {
  // Structured data from metadata - NO CONTENT PARSING
  toolCall: ToolCallData;
  toolResult?: ToolResultData;
  
  // Metadata
  assistantTimestamp?: string;
  toolTimestamp?: string;
  isSuccess?: boolean;
  isStreaming?: boolean;
  project?: Project;
  messages?: any[];
  agentStatus?: string;
  currentIndex?: number;
  totalCalls?: number;
  onFileClick?: (filePath: string) => void;
  viewToggle?: React.ReactNode;
}

export interface BrowserToolViewProps extends ToolViewProps {
  name?: string;
}
