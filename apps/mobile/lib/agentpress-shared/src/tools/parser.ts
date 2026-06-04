import type { UnifiedMessage } from '../types/messages';

export interface ParsedToolData {
  toolName: string;
  functionName: string;
  arguments: Record<string, any>;
  result: { output: any; success: boolean };
  timestamp?: string;
  toolCallId?: string;
}

export interface ParsedXmlToolCall {
  functionName: string;
  parameters: Record<string, any>;
  rawXml: string;
}

export function parseToolMessage(messageOrContent: UnifiedMessage | any, content?: any): ParsedToolData | null {
  try {
    const msg = content || messageOrContent;
    if (!msg) return null;

    let parsed: any;
    if (typeof msg === 'string') {
      parsed = JSON.parse(msg);
    } else if (typeof msg === 'object') {
      parsed = msg;
    } else {
      return null;
    }

    const toolName = parsed.function_name || parsed.name || parsed.tool || '';
    return {
      toolName,
      functionName: toolName,
      arguments: parsed.arguments || parsed.params || {},
      result: parsed.result || { output: parsed.output || '', success: true },
      timestamp: parsed.timestamp,
      toolCallId: parsed.tool_call_id,
    };
  } catch {
    return null;
  }
}

export function formatToolOutput(output: any, maxLength: number = 500): string {
  if (!output) return '';
  const str = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

export function parseXmlToolCalls(content: string): ParsedXmlToolCall[] {
  const results: ParsedXmlToolCall[] = [];
  const regex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const functionName = match[1];
    const inner = match[2];
    const parameters: Record<string, any> = {};

    const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(inner)) !== null) {
      parameters[paramMatch[1]] = paramMatch[2].trim();
    }

    results.push({ functionName, parameters, rawXml: match[0] });
  }

  return results;
}

export function isNewXmlFormat(content: string): boolean {
  return /<\w+>[\s\S]*<\/\w+>/.test(content);
}

export function preprocessTextOnlyTools(content: string): string {
  return content;
}

export function stripXMLTags(content: string): string {
  return content.replace(/<\/?[^>]+>/g, '');
}

export function getUserFriendlyToolName(toolName: string): string {
  const nameMap: Record<string, string> = {
    browser_action: 'Browser',
    web_search: 'Web Search',
    create_file: 'Create File',
    read_file: 'Read File',
    str_replace_editor: 'Edit File',
    delete_file: 'Delete File',
    execute_command: 'Terminal',
    list_directory: 'List Files',
    ask_user: 'Question',
    complete: 'Complete',
    'sb-computer-use': 'Computer',
  };
  return nameMap[toolName] || toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
