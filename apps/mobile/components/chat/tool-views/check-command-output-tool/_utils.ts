import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

interface CheckCommandOutputData {
  sessionName: string | null;
  output: string | null;
  status: string | null;
  success: boolean;
}

export function extractCheckCommandOutputData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true
): CheckCommandOutputData {
  // Extract session_name from toolCall.arguments (from metadata)
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};
  const sessionName: string | null = args.session_name || args.sessionName || null;
  
  // Extract output from toolResult.output (from metadata)
  let output: string | null = null;
  let status: string | null = null;
  let actualIsSuccess = isSuccess;

  if (toolResult?.output) {
    if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      const outputObj = toolResult.output as any;
      output = outputObj.output || outputObj.stdout || null;
      status = outputObj.status || null;
    } else if (typeof toolResult.output === 'string') {
      output = toolResult.output;
    }
    
    if (toolResult.success !== undefined) {
      actualIsSuccess = toolResult.success;
    }
  }

  return {
    sessionName,
    output,
    status,
    success: actualIsSuccess,
  };
}
