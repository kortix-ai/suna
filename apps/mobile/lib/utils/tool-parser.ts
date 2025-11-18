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

export interface ParsedXmlToolCall {
  functionName: string;
  parameters: Record<string, any>;
  rawXml: string;
}

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

function parseParameterValue(value: string): any {
  const trimmed = value.trim();
  
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
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

export function isNewXmlFormat(content: string): boolean {
  return /<function_calls>[\s\S]*<invoke\s+name=/.test(content);
}

export function preprocessTextOnlyTools(content: string): string {
  if (!content || typeof content !== 'string') {
    return content || '';
  }

  content = content.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, '$1');
  });

  content = content.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, '$1');
  });


  content = content.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi, '$1');
  });

  content = content.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi, '$1');
  });


  content = content.replace(/<ask[^>]*>([\s\S]*?)<\/ask>/gi, (match) => {
    if (match.match(/<ask[^>]*attachments=/i)) return match;
    return match.replace(/<ask[^>]*>([\s\S]*?)<\/ask>/gi, '$1');
  });

  content = content.replace(/<complete[^>]*>([\s\S]*?)<\/complete>/gi, (match) => {
    if (match.match(/<complete[^>]*attachments=/i)) return match;
    return match.replace(/<complete[^>]*>([\s\S]*?)<\/complete>/gi, '$1');
  });
  return content;
}

export const HIDE_STREAMING_XML_TAGS = [
  'create-tasks',
  'execute-command',
  'create-file',
  'delete-file',
  'full-file-rewrite',
  'edit-file',
  'str-replace',
  'browser-click-element',
  'browser-close-tab',
  'browser-navigate-to',
  'browser-input-text',
];

export const STREAMABLE_TOOLS = new Set([
  'create-tasks',
  'update-tasks',
  'execute-command',
  'create-file',
  'full-file-rewrite',
  'edit-file',
  'browser-navigate-to',
  'browser-input-text',
  'browser-click-element',
  'search-web',
  'crawl-website',
  'view-image',
  'expose-port',
  'get-agent-config',
  'search-mcp-servers',
  'create-credential-profile',
]);

export function extractStreamingContent(content: string, toolName: string): string {
  if (!content || typeof content !== 'string') return '';
  
  const commonParams = ['text', 'content', 'data', 'config', 'description', 'prompt', 'command', 'file_contents'];
  
  for (const param of commonParams) {
    const match = content.match(new RegExp(`<parameter\\s+name=["']${param}["']>([\\s\\S]*?)(<\\/parameter>|$)`, 'i'));
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  const cleaned = content
    .replace(/<function_calls[^>]*>/gi, '')
    .replace(/<\/function_calls>/gi, '')
    .replace(/<invoke[^>]*>/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<\/?parameter[^>]*>/gi, '');
  
  return cleaned.trim();
}

export function stripXMLTags(content: string): string {
  if (!content || typeof content !== 'string') return '';
  
  let cleaned = content;
  
  cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
  
  const htmlTags = 'br|p|div|span|strong|em|ul|ol|li|a|code|pre|h[1-6]|blockquote|img';
  cleaned = cleaned.replace(
    new RegExp(`<(?!${htmlTags})([a-zA-Z\\-_]+)(?:\\s+[^>]*)?>(?:[\\s\\S]*?)<\\/\\1>`, 'g'),
    ''
  );
  
  cleaned = cleaned.replace(
    new RegExp(`<(?!br|img)([a-zA-Z\\-_]+)(?:\\s+[^>]*)?\\/>`, 'g'),
    ''
  );
  
  return cleaned.replace(/\n\n\n+/g, '\n\n').trim();
}

export function detectAndStripPartialXML(content: string): string {
  if (!content || typeof content !== 'string') return content;
  
  if (content.includes('<function_calls>')) {
    const index = content.indexOf('<function_calls>');
    return content.substring(0, index).trim();
  }
  
  const partialXmlMatch = content.match(/<[a-zA-Z_:][a-zA-Z0-9_:]*$|<$/);
  if (partialXmlMatch && partialXmlMatch.index !== undefined) {
    return content.substring(0, partialXmlMatch.index).trim();
  }
  
  for (const tag of HIDE_STREAMING_XML_TAGS) {
    const openingTagPattern = `<${tag}`;
    const index = content.indexOf(openingTagPattern);
    if (index !== -1) {
      return content.substring(0, index).trim();
    }
  }
  
  return content;
}
