import type { ParsedToolData } from '@/lib/utils/tool-parser';

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

export function extractCheckCommandOutputData(toolData: ParsedToolData): CheckCommandOutputData {
  const { arguments: args, result } = toolData;
  
  let sessionName = args?.session_name || null;
  let output: string | null = null;
  let status: string | null = null;
  
  if (result.output) {
    const parsed = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
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
    success: result.success ?? true
  };
}

