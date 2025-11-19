import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface CompleteToolData {
  text: string | null;
  attachments: string[];
  follow_up_prompts: string[];
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

export function extractCompleteData(toolData: ParsedToolData): CompleteToolData {
  const { arguments: args, result } = toolData;
  
  let text = args?.text || args?.summary || null;
  let attachments: string[] = [];
  let follow_up_prompts: string[] = [];
  
  if (args?.attachments) {
    if (typeof args.attachments === 'string') {
      attachments = args.attachments.split(',').map((a: string) => a.trim()).filter(Boolean);
    } else if (Array.isArray(args.attachments)) {
      attachments = args.attachments;
    }
  }
  
  if (args?.follow_up_prompts && Array.isArray(args.follow_up_prompts)) {
    follow_up_prompts = args.follow_up_prompts.filter((p: string) => p && p.trim().length > 0);
  }
  
  if (result.output && typeof result.output === 'string') {
    text = text || result.output;
  }
  
  return {
    text,
    attachments,
    follow_up_prompts,
    success: result.success ?? true
  };
}

