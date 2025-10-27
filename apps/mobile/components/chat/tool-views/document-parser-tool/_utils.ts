import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface DocumentParserData {
  filePath: string | null;
  fileName: string | null;
  content: string | null;
  pageCount: number | null;
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

export function extractDocumentParserData(toolData: ParsedToolData): DocumentParserData {
  const { arguments: args, result } = toolData;
  
  let filePath = args?.file_path || args?.filepath || args?.path || null;
  let fileName = filePath?.split('/').pop() || null;
  let content: string | null = null;
  let pageCount: number | null = null;
  
  if (result.output) {
    const parsed = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (parsed && typeof parsed === 'object') {
      content = parsed.content || parsed.text || null;
      pageCount = parsed.page_count || parsed.pageCount || parsed.pages || null;
      fileName = fileName || parsed.file_name || parsed.fileName || null;
    } else if (typeof parsed === 'string') {
      content = parsed;
    }
  }
  
  return {
    filePath,
    fileName,
    content,
    pageCount,
    success: result.success ?? true
  };
}

