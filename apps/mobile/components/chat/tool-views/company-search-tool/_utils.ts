import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

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

export function extractCompanySearchData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): CompanySearchData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let query = args?.query || null;
  let results: CompanySearchResult[] = [];
  let total_results = 0;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
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
    success: toolResult?.success ?? true
  };
}

