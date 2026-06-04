import type { ToolCallData, ToolResultData } from '../types';

export interface AskToolData {
  text: string | null;
  attachments: string[];
  follow_up_answers: string[];
  success: boolean;
}

export function extractAskData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true
): AskToolData {
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
  
  let text = args?.text || null;
  let attachments: string[] = [];
  let follow_up_answers: string[] = [];
  
  if (args?.attachments) {
    if (typeof args.attachments === 'string') {
      attachments = args.attachments.split(',').map((a: string) => a.trim()).filter(Boolean);
    } else if (Array.isArray(args.attachments)) {
      attachments = args.attachments;
    }
  }
  
  if (args?.follow_up_answers && Array.isArray(args.follow_up_answers)) {
    follow_up_answers = args.follow_up_answers.filter((a: string) => a && a.trim().length > 0);
  }
  
  return {
    text,
    attachments,
    follow_up_answers,
    success: toolResult?.success ?? isSuccess
  };
}

