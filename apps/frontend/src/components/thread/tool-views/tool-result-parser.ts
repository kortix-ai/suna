/**
 * Tool Result Parser for handling both old and new tool result formats
 * 
 * Supports:
 * - New structured format with tool_execution
 * - Legacy XML-wrapped format
 * - Legacy direct format
 */

export interface ParsedToolResult {
  toolName: string;
  functionName: string;
  toolOutput: string;
  isSuccess: boolean;
  arguments?: Record<string, any>;
  timestamp?: string;
  toolCallId?: string;
  summary?: string;
}

/**
 * Parse tool result from metadata ONLY
 * NO backwards compatibility
 */
export function parseToolResult(content: any): ParsedToolResult | null {
  // This function is kept for compatibility but should not be used
  // Tool results should come from metadata.result
    return null;
  }

// Removed parseObjectToolResult - we only use metadata now

/**
 * Check if message has tool result in metadata
 */
export function isToolResult(message: any): boolean {
  if (!message || !message.metadata) return false;
  try {
    const metadata = typeof message.metadata === 'string' 
      ? JSON.parse(message.metadata) 
      : message.metadata;
    return !!metadata.result;
  } catch {
    return false;
  }
}

/**
 * Format tool name for display (convert kebab-case to Title Case)
 */
export function formatToolNameForDisplay(toolName: string): string {
  return toolName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
} 