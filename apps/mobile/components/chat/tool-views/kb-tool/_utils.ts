import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface KbData {
  files?: any[];
  folders?: any[];
  items?: any[];
  message?: string;
  path?: string;
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

export function extractKbData(toolData: ParsedToolData): KbData {
  const { result, arguments: args } = toolData;
  
  let data: any = {};
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      data = output;
    } else if (typeof output === 'string') {
      data = { message: output };
    }
  }
  
  return {
    files: data.files,
    folders: data.folders,
    items: data.items,
    message: data.message || data.status,
    path: args?.path || data.path,
    success: result.success ?? true
  };
}

