import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface AuthorDetails {
  author_id: string;
  name: string;
  url: string;
  affiliations: string[];
  homepage?: string;
  paper_count: number;
  citation_count: number;
  h_index: number;
  aliases?: string[];
}

export interface AuthorDetailsData {
  author: AuthorDetails | null;
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

export function extractAuthorDetailsData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): AuthorDetailsData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let author: AuthorDetails | null = null;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      author = output.author || output;
    }
  }
  
  return {
    author,
    success: toolResult?.success ?? true
  };
}

