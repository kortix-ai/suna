/**
 * Tool call parsing and display utilities
 * Handles parsing tool call arguments and extracting display information
 */

import type { StreamingToolCall } from '../types/streaming';
import { safeJsonParse } from '../utils';
import { getUserFriendlyToolName } from './formatter';

/**
 * Tool result data structure from metadata
 */
export interface ToolResultData {
  success: boolean;
  output: any;
  error?: string | null;
  timestamp?: string;
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
 * Tool category type
 */
export type ToolCategory = 'file' | 'command' | 'web' | 'communication' | 'other';

/**
 * Parse tool call arguments from string or object
 * Handles partial JSON during streaming
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
export function getToolCategory(functionName: string): ToolCategory {
  const name = normalizeToolName(functionName);
  
  if (name === 'ask' || name === 'complete') return 'communication';
  if (isFileOperationTool(functionName)) return 'file';
  if (isCommandTool(functionName)) return 'command';
  if (isWebTool(functionName)) return 'web';
  
  return 'other';
}

