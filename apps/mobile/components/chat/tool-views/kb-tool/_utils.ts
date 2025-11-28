import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface KbData {
  files?: any[];
  folders?: any[];
  items?: any[];
  message?: string;
  path?: string;
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

export function extractKbData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): KbData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })()
      : {};
  
  let data: any = {};
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      data = output;
    } else if (typeof output === 'string') {
      data = { message: output };
    }
  }
  
  return {
    files: data.files,
    folders: data.folders,
    items: data.items,
    message: data.message || data.status,
    path: args?.path || data.path,
    success: toolResult?.success ?? true
  };
}

