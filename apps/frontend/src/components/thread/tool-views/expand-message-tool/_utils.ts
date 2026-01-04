import { ToolCallData, ToolResultData } from '../types';

export interface ExpandMessageData {
  messageId?: string;
  message?: string;
  status?: string;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
}


export function extractExpandMessageData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ExpandMessageData {
  const args = toolCall.arguments || {};
  const messageId = args.message_id || undefined;
  
  let message: string | undefined;
  let status: string | undefined;

  // Extract from toolResult output
  if (toolResult?.output) {
    const output = toolResult.output;
    
    if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output);
        status = parsed.status;
        message = parsed.message || parsed.content;
      } catch (e) {
        message = output;
      }
    } else if (typeof output === 'object' && output !== null) {
      const obj = output as any;
      status = obj.status;
      message = obj.message || obj.content;
    }
  }

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    messageId,
    message,
    status,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}

