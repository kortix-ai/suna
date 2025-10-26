import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface TerminateCommandData {
  sessionName: string | null;
  output: string | null;
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

export function extractTerminateCommandData(toolData: ParsedToolData): TerminateCommandData {
  const { arguments: args, result } = toolData;
  
  let sessionName = args?.session_name || null;
  let output: string | null = null;
  
  if (result.output) {
    const parsed = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (parsed && typeof parsed === 'object') {
      output = parsed.output || parsed.message || null;
      sessionName = sessionName || parsed.session_name || null;
    } else if (typeof parsed === 'string') {
      output = parsed;
    }
  }
  
  const terminationSuccess = output 
    ? (output.toLowerCase().includes('terminated') || output.toLowerCase().includes('killed'))
    : result.success ?? false;
  
  return {
    sessionName,
    output,
    success: terminationSuccess
  };
}

