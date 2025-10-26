import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface CompanySearchResult {
  id: string;
  url: string;
  company_name: string;
  company_location: string;
  company_industry: string;
  company_logo_url: string;
  description: string;
}

export interface CompanySearchData {
  query: string | null;
  total_results: number;
  results: CompanySearchResult[];
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

export function extractCompanySearchData(toolData: ParsedToolData): CompanySearchData {
  const { arguments: args, result } = toolData;
  
  let query = args?.query || null;
  let results: CompanySearchResult[] = [];
  let total_results = 0;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      query = query || output.query || null;
      total_results = output.total_results || 0;
      
      if (Array.isArray(output.results)) {
        results = output.results.map((r: any) => ({
          id: r.id || '',
          url: r.url || '',
          company_name: r.company_name || 'Unknown',
          company_location: r.company_location || '',
          company_industry: r.company_industry || '',
          company_logo_url: r.company_logo_url || '',
          description: r.description || ''
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

