import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface CompleteToolData {
  text: string | null;
  attachments: string[];
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
  
  if (args?.attachments) {
    if (typeof args.attachments === 'string') {
      attachments = args.attachments.split(',').map((a: string) => a.trim()).filter(Boolean);
    } else if (Array.isArray(args.attachments)) {
      attachments = args.attachments;
    }
  }
  
  if (result.output && typeof result.output === 'string') {
    text = text || result.output;
  }
  
  return {
    text,
    attachments,
    success: result.success ?? true
  };
}

