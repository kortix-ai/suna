import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface Paper {
  paper_id: string;
  title: string;
  year?: number;
  url: string;
  citation_count: number;
  venue?: string;
}

export interface AuthorPapersData {
  author_name: string | null;
  total_papers: number;
  papers: Paper[];
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

export function extractAuthorPapersData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): AuthorPapersData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let author_name = args?.author_name || null;
  let papers: Paper[] = [];
  let total_papers = 0;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      author_name = author_name || output.author_name || null;
      total_papers = output.total_papers || 0;
      
      if (Array.isArray(output.papers)) {
        papers = output.papers.map((p: any) => ({
          paper_id: p.paper_id || p.id || '',
          title: p.title || 'Untitled',
          year: p.year,
          url: p.url || '',
          citation_count: p.citation_count || 0,
          venue: p.venue
        }));
      }
    }
  }
  
  return {
    author_name,
    total_papers,
    papers,
    success: toolResult?.success ?? true
  };
}

