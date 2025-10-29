/**
 * Tool Parser Utility
 * 
 * Parses tool execution messages from the backend into a structured format.
 * The backend double-encodes tool data: { role: "user", content: "JSON_STRING" }
 * where JSON_STRING contains { tool_execution: {...} }
 */

import { safeJsonParse } from './message-grouping';

export interface ParsedToolData {
  toolName: string;
  functionName: string;
  arguments: Record<string, any>;
  result: {
    output: any;
    success: boolean;
  };
  timestamp?: string;
  toolCallId?: string;
}

interface ToolExecutionData {
  function_name?: string;
  xml_tag_name?: string;
  arguments?: Record<string, any>;
  result?: {
    output: any;
    success: boolean;
  };
  execution_details?: {
    timestamp?: string;
  };
  tool_call_id?: string;
}

/**
 * Extract tool execution data from parsed content
 */
function extractToolExecution(toolExecution: ToolExecutionData): ParsedToolData {
  return {
    toolName: (toolExecution.xml_tag_name || toolExecution.function_name || 'unknown').replace(/_/g, '-'),
    functionName: toolExecution.function_name || 'unknown',
    arguments: toolExecution.arguments || {},
    result: toolExecution.result || { output: null, success: false },
    timestamp: toolExecution.execution_details?.timestamp,
    toolCallId: toolExecution.tool_call_id,
  };
}

/**
 * Parse a tool message content into structured data
 * 
 * Handles backend double-encoding where content is a JSON string
 */
export function parseToolMessage(content: any): ParsedToolData | null {
  // Parse initial JSON if string
  const parsed = typeof content === 'string' ? safeJsonParse(content, content) : content;
  
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  // Handle double-encoded content: { role: "user", content: "JSON_STRING" }
  if (parsed.content && typeof parsed.content === 'string') {
    try {
      const contentParsed = JSON.parse(parsed.content);
      if (contentParsed.tool_execution && typeof contentParsed.tool_execution === 'object') {
        return extractToolExecution(contentParsed.tool_execution);
      }
    } catch (e) {
      // Silent fail, try other formats
    }
  }

  // Handle object content: { role: "user", content: { tool_execution: {...} } }
  if (parsed.content && typeof parsed.content === 'object' && parsed.content.tool_execution) {
    return extractToolExecution(parsed.content.tool_execution);
  }
  
  // Handle direct format: { tool_execution: {...} }
  if (parsed.tool_execution && typeof parsed.tool_execution === 'object') {
    return extractToolExecution(parsed.tool_execution);
  }
  
  // Legacy format: { tool_name, parameters, result }
  if (parsed.tool_name || parsed.xml_tag_name) {
    return {
      toolName: (parsed.xml_tag_name || parsed.tool_name || 'unknown').replace(/_/g, '-'),
      functionName: parsed.tool_name || parsed.xml_tag_name || 'unknown',
      arguments: parsed.parameters || parsed.arguments || {},
      result: parsed.result || { output: null, success: false },
      timestamp: undefined,
      toolCallId: undefined,
    };
  }
  
  return null;
}

/**
 * Format tool output for display with length limit
 */
export function formatToolOutput(output: any, maxLength: number = 50): string {
  if (!output) return 'No result';
  
  if (typeof output === 'string') {
    return output.length > maxLength ? `${output.substring(0, maxLength)}...` : output;
  }
  
  if (typeof output === 'object') {
    // Try to extract meaningful message from object
    const message = output.message || output.output || output.content;
    if (message && typeof message === 'string') {
      return message.length > maxLength ? `${message.substring(0, maxLength)}...` : message;
    }
    
    // Recursive call for nested output
    if (message) {
      return formatToolOutput(message, maxLength);
    }
    
    // Fall back to JSON string
    const jsonStr = JSON.stringify(output);
    return jsonStr.length > maxLength * 2 ? `${jsonStr.substring(0, maxLength * 2)}...` : jsonStr;
  }
  
  const str = String(output);
  return str.length > maxLength ? `${str.substring(0, maxLength)}...` : str;
}

/**
 * Strip XML invoke tags from assistant message content
 * XML tags are internal and should never be shown to users
 */
export function stripXMLTags(content: string): string {
  if (!content || typeof content !== 'string') return '';
  
  let cleaned = content;
  
  // Remove invoke blocks
  cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["'][\s\S]*?<\/invoke>/gi, '');
  
  // Remove old-style XML tool tags (preserve HTML tags)
  const htmlTags = 'br|p|div|span|strong|em|ul|ol|li|a|code|pre|h[1-6]|blockquote|img';
  cleaned = cleaned.replace(
    new RegExp(`<(?!${htmlTags})([a-zA-Z\\-_]+)(?:\\s+[^>]*)?>(?:[\\s\\S]*?)<\\/\\1>`, 'g'),
    ''
  );
  
  // Remove self-closing XML tool tags (preserve HTML tags)
  cleaned = cleaned.replace(
    new RegExp(`<(?!br|img)([a-zA-Z\\-_]+)(?:\\s+[^>]*)?\\/>`, 'g'),
    ''
  );
  
  // Clean up excessive whitespace
  return cleaned.replace(/\n\n\n+/g, '\n\n').trim();
}
