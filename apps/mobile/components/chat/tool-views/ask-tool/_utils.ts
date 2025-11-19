import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface AskToolData {
  text: string | null;
  attachments: string[];
  follow_up_answers: string[];
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

export function extractAskData(toolData: ParsedToolData): AskToolData {
  const { arguments: args, result } = toolData;
  
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
    success: result.success ?? true
  };
}

