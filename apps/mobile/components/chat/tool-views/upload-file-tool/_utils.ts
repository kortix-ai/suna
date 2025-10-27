import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface UploadFileData {
  filePath: string | null;
  fileName: string | null;
  fileSize?: number;
  message?: string;
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

export function extractUploadFileData(toolData: ParsedToolData): UploadFileData {
  const { arguments: args, result } = toolData;
  
  let filePath = args?.file_path || args?.filepath || null;
  let message: string | undefined;
  let fileSize: number | undefined;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      filePath = filePath || output.file_path || output.path || null;
      message = output.message;
      fileSize = output.file_size || output.size;
    } else if (typeof output === 'string') {
      message = output;
    }
  }
  
  const fileName = filePath ? filePath.split('/').pop() || null : null;
  
  return {
    filePath,
    fileName,
    fileSize,
    message,
    success: result.success ?? true
  };
}

