/**
 * Tool parsing utilities
 * Parses tool execution messages from the backend into structured format
 * 
 * NEW FORMAT (preferred): Parse from message.metadata
 * LEGACY FORMAT (fallback): Parse from message.content
 */

import type { UnifiedMessage, ParsedMetadata } from '../types';
import { safeJsonParse } from '../utils';

/**
 * Parsed tool data structure
 */
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

/**
 * Parsed XML tool call structure
 */
export interface ParsedXmlToolCall {
  functionName: string;
  parameters: Record<string, any>;
  rawXml: string;
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
 * Extract tool execution data from parsed content (legacy format)
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
 * Parse a tool message into structured data
 * 
 * NEW FORMAT: Parses from message.metadata (preferred)
 * LEGACY FORMAT: Falls back to parsing from message.content
 * 
 * @param message - The UnifiedMessage to parse (preferred)
 * @param content - Legacy: The content string/object to parse (fallback)
 */
export function parseToolMessage(messageOrContent: UnifiedMessage | any, content?: any): ParsedToolData | null {
  // NEW FORMAT: Parse from metadata (if UnifiedMessage provided)
  if (messageOrContent && typeof messageOrContent === 'object' && 'metadata' in messageOrContent) {
    const message = messageOrContent as UnifiedMessage;
    const metadata = safeJsonParse<Record<string, any>>(message.metadata, {});
    
    // Check for new format: metadata has function_name, tool_call_id, and result
    if (metadata.function_name && metadata.tool_call_id !== undefined) {
      const result = metadata.result || {};
      return {
        toolName: (metadata.function_name || 'unknown').replace(/_/g, '-'),
        functionName: metadata.function_name || 'unknown',
        arguments: metadata.arguments || {},
        result: {
          output: result.output !== undefined ? result.output : null,
          success: result.success !== undefined ? result.success : true,
        },
        timestamp: metadata.timestamp || message.created_at,
        toolCallId: metadata.tool_call_id,
      };
    }
    
    // If metadata doesn't have the new format, fall through to content parsing
  }
  
  // LEGACY FORMAT: Parse from content
  const contentToParse = content !== undefined ? content : messageOrContent;
  const parsed = typeof contentToParse === 'string' ? safeJsonParse(contentToParse, contentToParse) : contentToParse;
  
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
 * Parse XML tool calls from content string
 */
export function parseXmlToolCalls(content: string): ParsedXmlToolCall[] {
  const toolCalls: ParsedXmlToolCall[] = [];

  const functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
  let functionCallsMatch;
  
  while ((functionCallsMatch = functionCallsRegex.exec(content)) !== null) {
    const functionCallsContent = functionCallsMatch[1];
    
    const invokeRegex = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
    let invokeMatch;
    
    while ((invokeMatch = invokeRegex.exec(functionCallsContent)) !== null) {
      const functionName = invokeMatch[1];
      const invokeContent = invokeMatch[2];
      const parameters: Record<string, any> = {};
      
      const paramRegex = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
      let paramMatch;
      
      while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
        const paramName = paramMatch[1];
        const paramValue = paramMatch[2].trim();
        
        parameters[paramName] = parseParameterValue(paramValue);
      }
      
      toolCalls.push({
        functionName,
        parameters,
        rawXml: invokeMatch[0]
      });
    }
  }
  
  return toolCalls;
}

/**
 * Parse a parameter value from XML (handles JSON, booleans, numbers, strings)
 */
function parseParameterValue(value: string): any {
  const trimmed = value.trim();
  
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON, continue
    }
  }
  
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) return num;
  }
  
  return value;
}

/**
 * Check if content uses the new XML format (<function_calls> with <invoke>)
 */
export function isNewXmlFormat(content: string): boolean {
  return /<function_calls>[\s\S]*<invoke\s+name=/.test(content);
}

