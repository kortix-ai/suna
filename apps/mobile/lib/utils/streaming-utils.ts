/**
 * Streaming utilities for handling tool call streaming and text extraction
 * These are portable and can be used in both web and mobile apps
 */

/**
 * Tool call data structure from metadata
 */
export interface StreamingToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, any> | string; // Object when complete, string when partial
  source: 'native' | 'xml';
}

/**
 * Parsed metadata from streaming messages
 */
export interface StreamingMetadata {
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk';
  thread_run_id?: string;
  tool_calls?: StreamingToolCall[];
  [key: string]: any;
}

/**
 * Extract text value from a partial JSON string
 * Handles escaped quotes, newlines, and unicode characters
 * 
 * @param jsonString - The JSON string (may be partial/incomplete)
 * @returns The extracted text value, or empty string if not found
 */
export function extractTextFromPartialJson(jsonString: string): string {
  if (!jsonString || typeof jsonString !== 'string') return '';
  
  // First, try to parse as complete JSON
  try {
    const parsed = JSON.parse(jsonString);
    return parsed?.text || '';
  } catch (e) {
    // Partial JSON - need to extract text value manually
    // Try multiple patterns to find the "text" key
    let textKeyMatch = jsonString.match(/"text"\s*:\s*"/);
    if (!textKeyMatch) {
      textKeyMatch = jsonString.match(/\\?"text\\?"\s*:\s*\\?"/);
    }
    if (!textKeyMatch) {
      textKeyMatch = jsonString.match(/\\"text\\"\s*:\s*\\"/);
    }
    
    if (!textKeyMatch) return '';
    
    const startIndex = textKeyMatch.index! + textKeyMatch[0].length;
    let result = '';
    let i = startIndex;
    let escaped = false;
    
    // Extract string value handling escaped characters
    while (i < jsonString.length) {
      const char = jsonString[i];
      
      if (escaped) {
        // Handle escape sequences
        if (char === 'n') {
          result += '\n';
        } else if (char === 't') {
          result += '\t';
        } else if (char === 'r') {
          result += '\r';
        } else if (char === '\\') {
          result += '\\';
        } else if (char === '"') {
          result += '"';
        } else if (char === 'u' && i + 4 < jsonString.length) {
          // Unicode escape: \uXXXX
          const hex = jsonString.substring(i + 1, i + 5);
          try {
            result += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } catch (e) {
            result += char;
          }
        } else {
          result += char;
        }
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"' && !escaped) {
        // Check if we've hit the end of the string value
        if (i + 1 >= jsonString.length || 
            jsonString[i + 1] === ',' || 
            jsonString[i + 1] === '}' ||
            jsonString[i + 1] === ']') {
          break;
        }
        result += char;
      } else {
        result += char;
      }
      i++;
    }
    
    return result;
  }
}

/**
 * Extract text content from streaming ask/complete XML
 * Strips all XML tags and extracts the text parameter
 * 
 * @param content - The XML content string
 * @param toolName - 'ask' or 'complete'
 * @returns The extracted text content
 */
export function extractTextFromStreamingAskComplete(content: string, toolName: 'ask' | 'complete'): string {
  if (!content) return '';
  
  // Remove function_calls wrapper if present
  let cleaned = content.replace(/<function_calls[^>]*>/gi, '').replace(/<\/function_calls>/gi, '');
  
  // Try to extract from new format: <invoke name="complete"> <parameter name="text">content</parameter> </invoke>
  const invokeMatch = cleaned.match(new RegExp(`<invoke[^>]*name=["']${toolName}["'][^>]*>([\\s\\S]*?)<\\/invoke>`, 'i'));
  if (invokeMatch) {
    const invokeContent = invokeMatch[1];
    // Extract text parameter
    const textParamMatch = invokeContent.match(/<parameter[^>]*name=["']text["'][^>]*>([\s\S]*?)(?:<\/parameter>|$)/i);
    if (textParamMatch) {
      return textParamMatch[1].trim();
    }
  }
  
  // Fall back to old format: <ask>content</ask> or <complete>content</complete>
  const oldFormatMatch = cleaned.match(new RegExp(`<${toolName}[^>]*>([\\s\\S]*?)(?:<\\/${toolName}>|$)`, 'i'));
  if (oldFormatMatch) {
    // Remove any nested parameter tags
    let text = oldFormatMatch[1];
    text = text.replace(/<parameter[^>]*>([\s\S]*?)<\/parameter>/gi, '$1');
    text = text.replace(/<[^>]+>/g, ''); // Remove any remaining tags
    return text.trim();
  }
  
  return '';
}

/**
 * Check if a tool call is an ask or complete tool
 * Handles both underscore and hyphen naming conventions
 * 
 * @param functionName - The function/tool name
 * @returns true if it's an ask or complete tool
 */
export function isAskOrCompleteTool(functionName: string | undefined): boolean {
  if (!functionName) return false;
  const normalizedName = functionName.replace(/_/g, '-').toLowerCase();
  return normalizedName === 'ask' || normalizedName === 'complete';
}

/**
 * Get the normalized tool name ('ask' or 'complete')
 * 
 * @param functionName - The function/tool name
 * @returns 'ask', 'complete', or null if not an ask/complete tool
 */
export function getAskCompleteToolType(functionName: string | undefined): 'ask' | 'complete' | null {
  if (!functionName) return null;
  const normalizedName = functionName.replace(/_/g, '-').toLowerCase();
  if (normalizedName === 'ask') return 'ask';
  if (normalizedName === 'complete') return 'complete';
  return null;
}

/**
 * Extract text from tool call arguments
 * Handles both string (partial JSON during streaming) and object (complete) formats
 * 
 * @param args - The arguments (string or object)
 * @returns The extracted text, or empty string
 */
export function extractTextFromArguments(args: string | Record<string, any> | undefined | null): string {
  if (!args) return '';
  
  if (typeof args === 'string') {
    // Try to parse as complete JSON first
    try {
      const parsed = JSON.parse(args);
      return parsed?.text || '';
    } catch (e) {
      // Partial JSON - use extraction function
      return extractTextFromPartialJson(args);
    }
  } else if (typeof args === 'object' && args !== null) {
    return args.text || '';
  }
  
  return '';
}

/**
 * Find ask/complete tool call in a list of tool calls
 * 
 * @param toolCalls - Array of tool calls from metadata
 * @returns The ask/complete tool call, or undefined
 */
export function findAskOrCompleteTool(toolCalls: StreamingToolCall[] | undefined): StreamingToolCall | undefined {
  if (!toolCalls || !Array.isArray(toolCalls)) return undefined;
  
  return toolCalls.find(tc => isAskOrCompleteTool(tc.function_name));
}

/**
 * Extract streaming ask/complete text from a tool call message
 * This is the main function to use for rendering streaming ask/complete content
 * 
 * @param toolCalls - Array of tool calls from metadata
 * @returns Object with toolType and text, or null if not ask/complete
 */
export function extractStreamingAskCompleteContent(
  toolCalls: StreamingToolCall[] | undefined
): { toolType: 'ask' | 'complete'; text: string } | null {
  const askOrCompleteTool = findAskOrCompleteTool(toolCalls);
  if (!askOrCompleteTool) return null;
  
  const toolType = getAskCompleteToolType(askOrCompleteTool.function_name);
  if (!toolType) return null;
  
  const text = extractTextFromArguments(askOrCompleteTool.arguments);
  
  return { toolType, text };
}

/**
 * Check if a streaming message should skip rendering
 * Returns true if the last complete message already has the ask/complete content
 * 
 * @param lastMessageMetadata - Metadata from the last complete message
 * @returns true if streaming render should be skipped
 */
export function shouldSkipStreamingRender(lastMessageMetadata: StreamingMetadata | undefined): boolean {
  if (!lastMessageMetadata) return false;
  
  const toolCalls = lastMessageMetadata.tool_calls || [];
  const hasAskOrComplete = toolCalls.some(tc => isAskOrCompleteTool(tc.function_name));
  const isComplete = lastMessageMetadata.stream_status === 'complete';
  
  return hasAskOrComplete && isComplete;
}

