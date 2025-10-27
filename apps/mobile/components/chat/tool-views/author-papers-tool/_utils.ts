import type { ParsedToolData } from '@/lib/utils/tool-parser';

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

export function extractAuthorPapersData(toolData: ParsedToolData): AuthorPapersData {
  const { arguments: args, result } = toolData;
  
  let author_name = args?.author_name || null;
  let papers: Paper[] = [];
  let total_papers = 0;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
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
    success: result.success ?? true
  };
}

