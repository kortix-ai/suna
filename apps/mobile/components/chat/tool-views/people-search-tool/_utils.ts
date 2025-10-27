import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface PeopleSearchResult {
  id: string;
  url: string;
  person_name: string;
  person_location: string;
  person_position: string;
  person_picture_url: string;
  description: string;
}

export interface PeopleSearchData {
  query: string | null;
  total_results: number;
  results: PeopleSearchResult[];
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

export function extractPeopleSearchData(toolData: ParsedToolData): PeopleSearchData {
  const { arguments: args, result } = toolData;
  
  let query = args?.query || null;
  let results: PeopleSearchResult[] = [];
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
          person_name: r.person_name || 'Unknown',
          person_location: r.person_location || '',
          person_position: r.person_position || '',
          person_picture_url: r.person_picture_url || '',
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

