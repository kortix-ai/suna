import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface AuthorDetails {
  author_id: string;
  name: string;
  url: string;
  affiliations: string[];
  homepage?: string;
  paper_count: number;
  citation_count: number;
  h_index: number;
  aliases?: string[];
}

export interface AuthorDetailsData {
  author: AuthorDetails | null;
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

export function extractAuthorDetailsData(toolData: ParsedToolData): AuthorDetailsData {
  const { result } = toolData;
  
  let author: AuthorDetails | null = null;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      author = output.author || output;
    }
  }
  
  return {
    author,
    success: result.success ?? true
  };
}

