import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface ExpandMessageData {
  expanded_content: string | null;
  original_content?: string;
  success: boolean;
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractExpandMessageData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): ExpandMessageData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let expanded_content: string | null = null;
  let original_content: string | undefined;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      expanded_content = output.expanded_content || output.content || null;
      original_content = args?.content;
    } else if (typeof output === 'string') {
      expanded_content = output;
    }
  }
  
  return {
    expanded_content,
    original_content,
    success: toolResult?.success ?? true
  };
}

