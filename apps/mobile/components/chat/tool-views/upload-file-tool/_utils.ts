import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

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

export function extractUploadFileData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): UploadFileData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let filePath = args?.file_path || args?.filepath || null;
  let message: string | undefined;
  let fileSize: number | undefined;
  
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
    }
  }
  
  const fileName = filePath ? filePath.split('/').pop() || null : null;
  
  return {
    filePath,
    fileName,
    fileSize,
    message,
    success: toolResult?.success ?? true
  };
}

