/**
 * Tool call utilities for parsing and handling tool call data
 * These are portable and can be used in both web and mobile apps
 */

import { StreamingToolCall } from './streaming-utils';

/**
 * Tool result data structure from metadata
 */
export interface ToolResultData {
  success: boolean;
  output: any;
  error?: string | null;
}

/**
 * Parsed tool call data for display
 */
export interface ParsedToolCallData {
  toolCallId: string;
  functionName: string;
  displayName: string;
  source: 'native' | 'xml';
  arguments: Record<string, any>;
  // Common argument extractions
  filePath?: string;
  command?: string;
  query?: string;
  url?: string;
  text?: string;
}

/**
 * Safe JSON parse with fallback
 */
export function safeJsonParse<T>(json: string | undefined | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Parse tool call arguments from string or object
 * 
 * @param args - Arguments (string JSON or object)
 * @returns Parsed arguments object
 */
export function parseToolCallArguments(args: string | Record<string, any> | undefined | null): Record<string, any> {
  if (!args) return {};
  
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      // Partial JSON during streaming - return empty
      return {};
    }
  }
  
  if (typeof args === 'object' && args !== null) {
    return args;
  }
  
  return {};
}

/**
 * Get user-friendly tool name from function name
 * Converts snake_case or kebab-case to Title Case
 * 
 * @param functionName - The raw function name
 * @returns User-friendly display name
 */
export function getUserFriendlyToolName(functionName: string): string {
  if (!functionName) return 'Unknown Tool';
  
  return functionName
    .replace(/_/g, '-')
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Normalize tool name to consistent format (kebab-case lowercase)
 * 
 * @param functionName - The raw function name
 * @returns Normalized name
 */
export function normalizeToolName(functionName: string): string {
  if (!functionName) return '';
  return functionName.replace(/_/g, '-').toLowerCase();
}

/**
 * Extract common display parameters from tool arguments
 * Used for showing context in tool call buttons
 * 
 * @param args - Parsed arguments object
 * @returns Primary display value (file path, command, query, etc.)
 */
export function getToolDisplayParam(args: Record<string, any>): string {
  // Priority order for display
  return (
    args.file_path ||
    args.path ||
    args.target_file ||
    args.command ||
    args.query ||
    args.url ||
    args.session_name ||
    ''
  );
}

/**
 * Parse a streaming tool call into display-ready data
 * 
 * @param toolCall - The streaming tool call from metadata
 * @returns Parsed tool call data for display
 */
export function parseToolCallForDisplay(toolCall: StreamingToolCall): ParsedToolCallData {
  const args = parseToolCallArguments(toolCall.arguments);
  const normalizedName = normalizeToolName(toolCall.function_name);
  
  return {
    toolCallId: toolCall.tool_call_id,
    functionName: toolCall.function_name,
    displayName: getUserFriendlyToolName(toolCall.function_name),
    source: toolCall.source,
    arguments: args,
    filePath: args.file_path || args.path || args.target_file,
    command: args.command,
    query: args.query,
    url: args.url,
    text: args.text,
  };
}

/**
 * Extract all tool calls from metadata and parse them
 * 
 * @param metadata - The message metadata (string or parsed object)
 * @returns Array of parsed tool call data
 */
export function extractAndParseToolCalls(
  metadata: string | Record<string, any> | undefined | null
): ParsedToolCallData[] {
  if (!metadata) return [];
  
  const parsed = typeof metadata === 'string' 
    ? safeJsonParse<Record<string, any>>(metadata, {})
    : metadata;
  
  const toolCalls = parsed.tool_calls as StreamingToolCall[] | undefined;
  if (!toolCalls || !Array.isArray(toolCalls)) return [];
  
  return toolCalls.map(parseToolCallForDisplay);
}

/**
 * Check if a tool call is a file operation
 * 
 * @param functionName - The function name
 * @returns true if it's a file operation tool
 */
export function isFileOperationTool(functionName: string): boolean {
  const name = normalizeToolName(functionName);
  const fileTools = [
    'read-file',
    'write-file',
    'create-file',
    'edit-file',
    'str-replace-editor',
    'delete-file',
    'list-dir',
    'list-files',
  ];
  return fileTools.includes(name);
}

/**
 * Check if a tool call is a command execution
 * 
 * @param functionName - The function name
 * @returns true if it's a command execution tool
 */
export function isCommandTool(functionName: string): boolean {
  const name = normalizeToolName(functionName);
  const commandTools = [
    'execute-command',
    'run-command',
    'shell',
    'terminal',
  ];
  return commandTools.includes(name);
}

/**
 * Check if a tool call is a web/browser operation
 * 
 * @param functionName - The function name
 * @returns true if it's a web operation tool
 */
export function isWebTool(functionName: string): boolean {
  const name = normalizeToolName(functionName);
  const webTools = [
    'web-search',
    'web-scrape',
    'browse-web',
    'browser',
    'screenshot',
  ];
  return webTools.includes(name);
}

/**
 * Get the category of a tool call
 * 
 * @param functionName - The function name
 * @returns Tool category
 */
export function getToolCategory(functionName: string): 'file' | 'command' | 'web' | 'communication' | 'other' {
  const name = normalizeToolName(functionName);
  
  if (name === 'ask' || name === 'complete') return 'communication';
  if (isFileOperationTool(functionName)) return 'file';
  if (isCommandTool(functionName)) return 'command';
  if (isWebTool(functionName)) return 'web';
  
  return 'other';
}

