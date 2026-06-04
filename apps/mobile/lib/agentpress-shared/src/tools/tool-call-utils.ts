import type { StreamingToolCall } from '../types/streaming';

export interface ToolResultData {
  success: boolean;
  output: any;
  error?: string | null;
  timestamp?: string;
}

export interface ParsedToolCallData {
  toolCallId: string;
  functionName: string;
  displayName: string;
  source: 'native' | 'xml';
  arguments: Record<string, any>;
  filePath?: string;
  command?: string;
  query?: string;
  url?: string;
  text?: string;
}

export type ToolCategory = 'file' | 'command' | 'web' | 'communication' | 'other';

export function parseToolCallArguments(
  args: string | Record<string, any> | undefined | null
): Record<string, any> {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

export function normalizeToolName(functionName: string): string {
  return functionName.replace(/^(sb-|mcp_)/, '');
}

export function isFileOperationTool(functionName: string): boolean {
  return ['create_file', 'read_file', 'str_replace_editor', 'delete_file', 'list_directory'].includes(functionName);
}

export function isCommandTool(functionName: string): boolean {
  return ['execute_command', 'check_command_output', 'terminate_command'].includes(functionName);
}

export function isWebTool(functionName: string): boolean {
  return ['browser_action', 'web_search', 'web_scrape', 'web_crawl'].includes(functionName);
}

export function getToolCategory(functionName: string): ToolCategory {
  if (isFileOperationTool(functionName)) return 'file';
  if (isCommandTool(functionName)) return 'command';
  if (isWebTool(functionName)) return 'web';
  return 'other';
}

export function getToolDisplayParam(args: Record<string, any>): string {
  return args.path || args.command || args.query || args.url || args.text || '';
}

export function parseToolCallForDisplay(toolCall: StreamingToolCall): ParsedToolCallData {
  const args = parseToolCallArguments(toolCall.arguments);
  return {
    toolCallId: toolCall.tool_call_id,
    functionName: toolCall.function_name,
    displayName: toolCall.function_name,
    source: toolCall.source,
    arguments: args,
    filePath: args.path || args.file_path,
    command: args.command,
    query: args.query,
    url: args.url,
    text: args.text,
  };
}

export function extractAndParseToolCalls(
  metadata: string | Record<string, any> | undefined | null
): ParsedToolCallData[] {
  if (!metadata) return [];
  let parsed: any;
  if (typeof metadata === 'string') {
    try { parsed = JSON.parse(metadata); } catch { return []; }
  } else {
    parsed = metadata;
  }
  const toolCalls = parsed?.tool_calls || [];
  return toolCalls.map((tc: StreamingToolCall) => parseToolCallForDisplay(tc));
}
