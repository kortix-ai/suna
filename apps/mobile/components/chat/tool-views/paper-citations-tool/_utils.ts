import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface Citation {
  paper_id: string;
  title: string;
  year?: number;
  authors: string[];
  citation_count: number;
  url?: string;
}

export interface PaperCitationsData {
  paper_title: string | null;
  total_citations: number;
  citations: Citation[];
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

export function extractPaperCitationsData(toolData: ParsedToolData): PaperCitationsData {
  const { arguments: args, result } = toolData;
  
  let paper_title = args?.paper_title || null;
  let citations: Citation[] = [];
  let total_citations = 0;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      paper_title = paper_title || output.paper_title || null;
      total_citations = output.total_citations || 0;
      
      if (Array.isArray(output.citations)) {
        citations = output.citations.map((c: any) => ({
          paper_id: c.paper_id || c.id || '',
          title: c.title || 'Untitled',
          year: c.year,
          authors: c.authors || [],
          citation_count: c.citation_count || 0,
          url: c.url
        }));
      }
    }
  }
  
  return {
    paper_title,
    total_citations,
    citations,
    success: result.success ?? true
  };
}

