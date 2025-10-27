import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchData {
  query: string | null;
  results: WebSearchResult[];
  images: string[];
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

export function extractWebSearchData(toolData: ParsedToolData): WebSearchData {
  const { arguments: args, result } = toolData;
  
  let query = args?.query || null;
  let results: WebSearchResult[] = [];
  let images: string[] = [];
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output.batch_results && Array.isArray(output.batch_results)) {
      images = output.batch_results.reduce((acc: string[], res: any) => {
        return acc.concat(res.images || []);
      }, []);
      
      const queries = output.batch_results.map((r: any) => r.query).filter(Boolean);
      if (queries.length > 0) {
        query = queries.length > 1 ? `${queries.length} queries` : queries[0];
      }
    } else {
      images = output.images || [];
    }
    
    if (output.results && Array.isArray(output.results)) {
      results = output.results.map((r: any) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.content || r.snippet || ''
      }));
    }
  }
  
  return {
    query,
    results,
    images,
    success: result.success ?? true
  };
}

export function cleanUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function getFavicon(url: string): string | null {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  } catch (e) {
    return null;
  }
}

