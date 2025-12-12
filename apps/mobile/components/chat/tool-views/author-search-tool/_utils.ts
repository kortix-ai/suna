import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface AuthorSearchResult {
  author_id: string;
  name: string;
  url: string;
  affiliations: string[];
  homepage?: string;
  paper_count: number;
  citation_count: number;
  h_index: number;
}

export interface AuthorSearchData {
  query: string | null;
  total_results: number;
  results: AuthorSearchResult[];
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

export function extractAuthorSearchData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): AuthorSearchData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })()
      : {};
  
  let query = args?.query || null;
  let results: AuthorSearchResult[] = [];
  let total_results = 0;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      query = query || output.query || null;
      total_results = output.total_available || output.total_results || 0;
      
      if (Array.isArray(output.results)) {
        results = output.results.map((r: any) => ({
          author_id: r.author_id || '',
          name: r.name || 'Unknown Author',
          url: r.url || '',
          affiliations: r.affiliations || [],
          homepage: r.homepage,
          paper_count: r.paper_count || 0,
          citation_count: r.citation_count || 0,
          h_index: r.h_index || 0
        }));
      }
    }
  }
  
  return {
    query,
    total_results,
    results,
    success: toolResult?.success ?? true
  };
}

