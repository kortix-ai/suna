import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface PaperSearchResult {
  id: string;
  url: string;
  title: string;
  abstract?: string;
  year?: number;
  authors?: Array<{ name: string; author_id?: string }>;
  venue?: string;
  citation_count?: number;
  is_open_access?: boolean;
  pdf_url?: string | null;
  fields_of_study?: string[];
}

export interface PaperSearchData {
  query: string | null;
  total_results: number;
  results: PaperSearchResult[];
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

export function extractPaperSearchData(toolData: ParsedToolData): PaperSearchData {
  const { arguments: args, result } = toolData;
  
  let query = args?.query || null;
  let results: PaperSearchResult[] = [];
  let total_results = 0;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      query = query || output.query || null;
      total_results = output.total_available || output.total_results || 0;
      
      if (Array.isArray(output.results)) {
        results = output.results.map((r: any) => ({
          id: r.id || r.paper_id || '',
          url: r.url || '',
          title: r.title || 'Untitled Paper',
          abstract: r.abstract || r.description || '',
          year: r.year,
          authors: r.authors || [],
          venue: r.venue || r.journal,
          citation_count: r.citation_count,
          is_open_access: r.is_open_access,
          pdf_url: r.pdf_url,
          fields_of_study: r.fields_of_study || []
        }));
      }
    }
  }
  
  return {
    query,
    total_results,
    results,
    success: result.success ?? true
  };
}
