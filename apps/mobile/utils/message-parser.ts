import { Message } from '@/api/chat-api';
import { extractContentText, ParsedContent, ParsedMetadata, parseMessageContent, parseMessageMetadata } from './metadata-parser';
import { ParsedToolResult, parseToolResult } from './tool-result-parser';
import { detectStreamingTag, extractToolNameFromStream, formatToolNameForDisplay, ParsedToolCall, parseXmlToolCalls } from './xml-parser';

export interface ParsedMessage {
  originalMessage: Message;
  cleanContent: string;
  toolCalls: ParsedToolCall[];
  toolResults: ParsedToolResult[];
  hasTools: boolean;
  isToolOnly: boolean;
  metadata: ParsedMetadata;
  parsedContent: ParsedContent;
  isToolResultMessage: boolean;
}

export interface StreamProcessingResult {
  cleanContent: string;
  currentToolName: string | null;
  shouldHideContent: boolean;
  isStreamingTool: boolean;
}

export function parseMessage(message: Message): ParsedMessage {

  const metadata = parseMessageMetadata(message);
  const parsedContent = parseMessageContent(message);
    
  // Check if this is a tool result message that should not display content
  const isToolResultMessage = isMessageToolResult(message, metadata, parsedContent);
  
  
  // For tool result messages, don't extract display content
  const content = isToolResultMessage ? '' : extractContentText(message);
  
  
  const toolCalls = parseXmlToolCalls(content);
  const toolResults = parseMessageToolResults(message);
  
  const cleanContent = cleanContentFromTools(content, toolCalls);
  
  const result = {
    originalMessage: message,
    cleanContent,
    toolCalls,
    toolResults,
    hasTools: toolCalls.length > 0 || toolResults.length > 0,
    isToolOnly: cleanContent.trim().length === 0 && (toolCalls.length > 0 || toolResults.length > 0),
    metadata,
    parsedContent,
    isToolResultMessage,
  };
  
  return result;
}

function isMessageToolResult(message: Message, metadata: ParsedMetadata, parsedContent: ParsedContent): boolean {
  
  // Check message type FIRST - if it's system/status, it's definitely a tool result
  if (message.type === 'system' || message.type === 'status') {
    return true;
  }
  
  // Check if message type is "tool" (even if not in TypeScript definition)
  if ((message as any).type === 'tool') {
    return true;
  }
  
  // Check if message has tool execution metadata
  if (metadata.tool_execution || parsedContent.tool_execution) {
    return true;
  }
  
  // Check if metadata indicates this is a tool result
  if (metadata.assistant_message_id && metadata.parsing_details) {
    return true;
  }
  
  // Check if message content is pure tool result JSON
  if (typeof message.content === 'string') {
    const trimmed = message.content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        
        // SPECIFIC tool result indicators - NOT just any role field
        if (parsed.tool_execution || parsed.function_name || parsed.xml_tag_name || 
            parsed.tool_name || (parsed.result && parsed.function_name)) {
          return true;
        }
        
        // Don't flag normal user/assistant messages
        if (parsed.role === 'user' || parsed.role === 'assistant') {
          return false;
        }
        
      } catch (e) {
        // Silent parsing failure for non-JSON content
      }
    }
  }
  
  // Check if message content object has tool result fields  
  if (typeof message.content === 'object' && message.content !== null) {
    const content = message.content as any;
    
    // Check if the content field contains tool_execution JSON
    if (content.content && typeof content.content === 'string') {
      try {
        const innerParsed = JSON.parse(content.content);
        if (innerParsed.tool_execution) {
          return true;
        }
      } catch (e) {
        // Silent parsing failure for inner content
      }
    }
    
    // SPECIFIC tool result indicators - NOT just any role field
    if (content.tool_execution || content.function_name || content.xml_tag_name || 
        content.tool_name || (content.result && content.function_name)) {
      return true;
    }
    
    // Don't flag normal user/assistant messages UNLESS they have tool metadata
    if ((content.role === 'user' || content.role === 'assistant') && 
        !metadata.assistant_message_id && !metadata.parsing_details) {
      return false;
    }
  }
  
  return false;
}

export function processStreamContent(streamContent: string): StreamProcessingResult {
  const currentToolName = extractToolNameFromStream(streamContent);
  const { detectedTag, tagStartIndex } = detectStreamingTag(streamContent);
  
  const isStreamingTool = detectedTag !== null;
  const shouldHideContent = isStreamingTool && tagStartIndex >= 0;
  
  let cleanContent = streamContent;
  if (shouldHideContent && tagStartIndex >= 0) {
    cleanContent = streamContent.substring(0, tagStartIndex).trim();
  }
  
  return {
    cleanContent,
    currentToolName,
    shouldHideContent,
    isStreamingTool,
  };
}

function extractMessageContent(message: Message): string {
  return extractContentText(message);
}

function parseMessageToolResults(message: Message): ParsedToolResult[] {
  const results: ParsedToolResult[] = [];
  
  // Check if the message itself is a tool result
  const directResult = parseToolResult(message.content);
  if (directResult) {
    results.push(directResult);
  }
  
  // Check metadata for tool results
  if (message.metadata && typeof message.metadata === 'object') {
    const metadataResult = parseToolResult(message.metadata);
    if (metadataResult) {
      results.push(metadataResult);
    }
  }
  
  return results;
}

function cleanContentFromTools(content: string, toolCalls: ParsedToolCall[]): string {
  let cleanContent = content;
  
  // Remove function_calls blocks
  cleanContent = cleanContent.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
  
  // Remove individual tool XML for old format
  toolCalls.forEach(toolCall => {
    cleanContent = cleanContent.replace(toolCall.rawXml, '');
  });
  
  return cleanContent.trim();
}

export function getToolDisplayInfo(toolCall: ParsedToolCall): {
  displayName: string;
  primaryParam: string;
} {
  const displayName = formatToolNameForDisplay(toolCall.functionName);
  
  let primaryParam = '';
  if (toolCall.parameters.file_path) {
    primaryParam = toolCall.parameters.file_path;
  } else if (toolCall.parameters.command) {
    primaryParam = toolCall.parameters.command;
  } else if (toolCall.parameters.query) {
    primaryParam = toolCall.parameters.query;
  } else if (toolCall.parameters.url) {
    primaryParam = toolCall.parameters.url;
  } else if (toolCall.parameters.text) {
    primaryParam = toolCall.parameters.text;
  }
  
  return { displayName, primaryParam };
}

export { extractContentText, findLinkedToolResults, getToolExecutionFromMessage, groupRelatedMessages, isCompleteMessage, isStreamingMessage, ParsedContent, ParsedMetadata, parseMessageContent, parseMessageMetadata } from './metadata-parser';
export { ParsedToolResult } from './tool-result-parser';
export { extractToolNameFromStream, formatToolNameForDisplay, isNewXmlFormat, ParsedToolCall, parseXmlToolCalls } from './xml-parser';

