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
  xmlTagName?: string;
  toolOutput: string;
  isSuccess: boolean;
  arguments?: Record<string, any>;
  timestamp?: string;
  toolCallId?: string;
  summary?: string;
}

/**
 * Parse tool result content from various formats
 */
export function parseToolResult(content: any): ParsedToolResult | null {
  try {
    // Handle string content
    if (typeof content === 'string') {
      return parseStringToolResult(content);
    }

    // Handle object content
    if (typeof content === 'object' && content !== null) {
      return parseObjectToolResult(content);
    }

    return null;
  } catch (error) {
    console.error('Error parsing tool result:', error);
    return null;
  }
}

/**
 * Parse string-based tool result (legacy format)
 */
function parseStringToolResult(content: string): ParsedToolResult | null {
  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object') {
      return parseObjectToolResult(parsed);
    }
  } catch {
    // Not JSON, continue with string parsing
  }

  // Extract tool name from XML tags
  const toolMatch = content.match(/<\/?([\w-]+)>/);
  const toolName = toolMatch ? toolMatch[1] : 'unknown';

  // Check for success in ToolResult format
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

/**
 * Parse object-based tool result (new and legacy formats)
 */
function parseObjectToolResult(content: any): ParsedToolResult | null {
  // New structured format with tool_execution
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

  // Handle nested format with role and content
  if ('role' in content && 'content' in content && typeof content.content === 'object') {
    const nestedContent = content.content;
    
    // Check for new structured format nested in content
    if ('tool_execution' in nestedContent && typeof nestedContent.tool_execution === 'object') {
      return parseObjectToolResult(nestedContent);
    }

    // Legacy format with tool_name/xml_tag_name
    if ('tool_name' in nestedContent || 'xml_tag_name' in nestedContent) {
      const toolName = (nestedContent.tool_name || nestedContent.xml_tag_name || 'unknown').replace(/_/g, '-');
      return {
        toolName,
        functionName: toolName.replace(/-/g, '_'),
        toolOutput: nestedContent.result?.output || '',
        isSuccess: nestedContent.result?.success !== false,
      };
    }
  }

  // Handle nested format with role and string content
  if ('role' in content && 'content' in content && typeof content.content === 'string') {
    return parseStringToolResult(content.content);
  }

  // Legacy direct format
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

/**
 * Check if content contains a tool result
 */
export function isToolResult(content: any): boolean {
  if (typeof content === 'string') {
    return content.includes('<tool_result>') || content.includes('ToolResult');
  }

  if (typeof content === 'object' && content !== null) {
    return (
      'tool_execution' in content ||
      ('role' in content && 'content' in content) ||
      'tool_name' in content ||
      'xml_tag_name' in content
    );
  }

  return false;
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