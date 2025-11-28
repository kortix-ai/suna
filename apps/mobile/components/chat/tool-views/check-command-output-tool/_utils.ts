import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface CheckCommandOutputData {
  sessionName: string | null;
  output: string | null;
  status: string | null;
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

export function extractCheckCommandOutputData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): CheckCommandOutputData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let sessionName = args?.session_name || null;
  let output: string | null = null;
  let status: string | null = null;
  
  if (toolResult?.output) {
    const parsed = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (parsed && typeof parsed === 'object') {
      output = parsed.output || null;
      status = parsed.status || null;
      sessionName = sessionName || parsed.session_name || null;
    } else if (typeof parsed === 'string') {
      output = parsed;
    }
  }
  
  return {
    sessionName,
    output,
    status,
    success: toolResult?.success ?? true
  };
}

