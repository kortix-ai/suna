import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface Reference {
  paper_id: string;
  title: string;
  year?: number;
  authors: string[];
  citation_count: number;
  url?: string;
}

export interface PaperReferencesData {
  paper_title: string | null;
  total_references: number;
  references: Reference[];
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

export function extractPaperReferencesData(toolData: ParsedToolData): PaperReferencesData {
  const { arguments: args, result } = toolData;
  
  let paper_title = args?.paper_title || null;
  let references: Reference[] = [];
  let total_references = 0;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      paper_title = paper_title || output.paper_title || null;
      total_references = output.total_references || 0;
      
      if (Array.isArray(output.references)) {
        references = output.references.map((r: any) => ({
          paper_id: r.paper_id || r.id || '',
          title: r.title || 'Untitled',
          year: r.year,
          authors: r.authors || [],
          citation_count: r.citation_count || 0,
          url: r.url
        }));
      }
    }
  }
  
  return {
    paper_title,
    total_references,
    references,
    success: result.success ?? true
  };
}

