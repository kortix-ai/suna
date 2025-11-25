/**
 * Message and streaming utility functions
 * All exports are portable and can be used in both web and mobile apps
 */

// Types (portable)
export type {
  UnifiedMessage,
  ParsedContent,
  ParsedMetadata,
  ToolCallData,
  ToolResultData,
  MessageGroup,
  StreamingState,
  AgentStatus,
  ToolCallDisplayInfo,
} from './types';

// Streaming utilities (portable)
export {
  extractTextFromPartialJson,
  extractTextFromStreamingAskComplete,
  isAskOrCompleteTool,
  getAskCompleteToolType,
  extractTextFromArguments,
  findAskOrCompleteTool,
  extractStreamingAskCompleteContent,
  shouldSkipStreamingRender,
  type StreamingToolCall,
  type StreamingMetadata,
} from './streaming-utils';

// Tool call utilities (portable)
export {
  safeJsonParse,
  parseToolCallArguments,
  getUserFriendlyToolName,
  normalizeToolName,
  getToolDisplayParam,
  parseToolCallForDisplay,
  extractAndParseToolCalls,
  isFileOperationTool,
  isCommandTool,
  isWebTool,
  getToolCategory,
  type ParsedToolCallData,
} from './tool-call-utils';

// Assistant message renderer (web-specific due to React components)
export { 
  renderAssistantMessage, 
  type AssistantMessageRendererProps 
} from './assistant-message-renderer';
