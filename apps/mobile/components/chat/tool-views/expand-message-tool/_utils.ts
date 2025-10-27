import type { ParsedToolData } from '@/lib/utils/tool-parser';

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

export function extractExpandMessageData(toolData: ParsedToolData): ExpandMessageData {
  const { arguments: args, result } = toolData;
  
  let expanded_content: string | null = null;
  let original_content: string | undefined;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
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
    success: result.success ?? true
  };
}

