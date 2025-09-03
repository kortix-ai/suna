export interface ParsedToolResult {
  toolName: string;
  functionName: string;
  xmlTagName?: string;
  toolOutput: string;
  isSuccess: boolean;
  arguments?: Record<string, any>;
  timestamp?: string;
  toolCallId?: string;
  summary?: string;
}

export function parseToolResult(content: any): ParsedToolResult | null {
  try {
    if (typeof content === 'string') {
      return parseStringToolResult(content);
    }

    if (typeof content === 'object' && content !== null) {
      return parseObjectToolResult(content);
    }

    return null;
  } catch (error) {
    console.error('Error parsing tool result:', error);
    return null;
  }
}

function parseStringToolResult(content: string): ParsedToolResult | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object') {
      return parseObjectToolResult(parsed);
    }
  } catch {
    // Not JSON, continue with string parsing
  }

  const toolMatch = content.match(/<\/?([\w-]+)>/);
  const toolName = toolMatch ? toolMatch[1] : 'unknown';

  let isSuccess = true;
  if (content.includes('ToolResult')) {
    const successMatch = content.match(/success\s*=\s*(True|False|true|false)/i);
    if (successMatch) {
      isSuccess = successMatch[1].toLowerCase() === 'true';
    }
  }

  return {
    toolName: toolName.replace(/_/g, '-'),
    functionName: toolName.replace(/-/g, '_'),
    toolOutput: content,
    isSuccess,
  };
}

function parseObjectToolResult(content: any): ParsedToolResult | null {
  if ('tool_execution' in content && typeof content.tool_execution === 'object') {
    const toolExecution = content.tool_execution;
    const functionName = toolExecution.function_name || 'unknown';
    const xmlTagName = toolExecution.xml_tag_name || '';
    const toolName = (xmlTagName || functionName).replace(/_/g, '-');

    return {
      toolName,
      functionName,
      xmlTagName: xmlTagName || undefined,
      toolOutput: toolExecution.result?.output || '',
      isSuccess: toolExecution.result?.success !== false,
      arguments: toolExecution.arguments,
      timestamp: toolExecution.execution_details?.timestamp,
      toolCallId: toolExecution.tool_call_id,
      summary: content.summary,
    };
  }

  if ('role' in content && 'content' in content) {
    if (typeof content.content === 'object') {
      const nestedContent = content.content;
      if ('tool_execution' in nestedContent) {
        return parseObjectToolResult(nestedContent);
      }
      if ('tool_name' in nestedContent || 'xml_tag_name' in nestedContent) {
        const toolName = (nestedContent.tool_name || nestedContent.xml_tag_name || 'unknown').replace(/_/g, '-');
        return {
          toolName,
          functionName: toolName.replace(/-/g, '_'),
          toolOutput: nestedContent.result?.output || '',
          isSuccess: nestedContent.result?.success !== false,
        };
      }
    } else if (typeof content.content === 'string') {
      return parseStringToolResult(content.content);
    }
  }

  if ('tool_name' in content || 'xml_tag_name' in content) {
    const toolName = (content.tool_name || content.xml_tag_name || 'unknown').replace(/_/g, '-');
    return {
      toolName,
      functionName: toolName.replace(/-/g, '_'),
      toolOutput: content.result?.output || '',
      isSuccess: content.result?.success !== false,
    };
  }

  return null;
} 