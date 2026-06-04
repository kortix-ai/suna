import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface UploadFileData {
  filePath: string | null;
  fileName: string | null;
  fileSize?: number;
  message?: string;
  success: boolean;
  fileId?: string | null;
  secureUrl?: string | null;
  expiresAt?: string | null;
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

export function extractUploadFileData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): UploadFileData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let filePath = args?.file_path || args?.filepath || null;
  let message: string | undefined;
  let fileSize: number | undefined;
  let fileId: string | null = null;
  let secureUrl: string | null = null;
  let expiresAt: string | null = null;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      filePath = filePath || output.file_path || output.path || null;
      message = output.message;
      fileSize = output.file_size || output.size;
    } else if (typeof output === 'string') {
      message = output;
      
      const fileIdMatch = output.match(/📋 File ID: ([^\n]+)/);
      const urlMatch = output.match(/🔗 Secure Access URL: ([^\n]+)/);
      const expiresMatch = output.match(/⏰ URL expires: ([^\n]+)/);
      
      if (fileIdMatch) fileId = fileIdMatch[1];
      if (urlMatch) secureUrl = urlMatch[1];
      if (expiresMatch) expiresAt = expiresMatch[1];
    }
  }
  
  const fileName = filePath ? filePath.split('/').pop() || null : null;
  
  return {
    filePath,
    fileName,
    fileSize,
    message,
    success: toolResult?.success ?? true,
    fileId,
    secureUrl,
    expiresAt,
  };
}

