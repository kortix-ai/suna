import type { ToolCallData, ToolResultData } from '../types';

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

export function extractTerminateCommandData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true
): TerminateCommandData {
  // Parse arguments
  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
      args = toolCall.arguments;
    } else if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    }
  }
  
  let sessionName = args?.session_name || args?.sessionName || null;
  let output: string | null = null;
  
  if (toolResult?.output) {
    const parsed = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (parsed && typeof parsed === 'object') {
      output = parsed.output || parsed.message || null;
      sessionName = sessionName || parsed.session_name || parsed.sessionName || null;
    } else if (typeof parsed === 'string') {
      output = parsed;
    }
  }
  
  const terminationSuccess = output 
    ? (output.toLowerCase().includes('terminated') || output.toLowerCase().includes('killed'))
    : (toolResult?.success ?? isSuccess);
  
  return {
    sessionName,
    output,
    success: terminationSuccess
  };
}

