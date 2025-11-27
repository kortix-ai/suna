import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface Author {
  author_id: string;
  name: string;
  url?: string;
  affiliations?: string[];
}

export interface PaperDetails {
  paper_id: string;
  title: string;
  abstract?: string | null;
  tldr?: string | null;
  year?: number;
  url: string;
  authors: Author[];
  venue?: string;
  citation_count: number;
  reference_count: number;
  is_open_access: boolean;
  pdf_url?: string | null;
  fields_of_study?: string[];
}

export interface PaperDetailsData {
  paper: PaperDetails | null;
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

export function extractPaperDetailsData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): PaperDetailsData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let paper: PaperDetails | null = null;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      paper = output.paper || output;
    }
  }
  
  return {
    paper,
    success: toolResult?.success ?? true
  };
}

