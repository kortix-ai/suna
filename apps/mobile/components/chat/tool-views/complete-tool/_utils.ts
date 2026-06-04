import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

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

export function extractCompleteData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): CompleteToolData {
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
  
  let text = args?.text || args?.summary || null;
  let attachments: string[] = [];
  let follow_up_prompts: string[] = [];
  
  if (args?.attachments) {
    if (typeof args.attachments === 'string') {
      // Try parsing as JSON first (handles JSON stringified arrays like "[\"file1.json\", \"file2.json\"]")
      const trimmed = args.attachments.trim();
      if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || 
          (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            attachments = parsed.filter((a: any) => a && typeof a === 'string' && a.trim().length > 0);
          } else {
            // Not an array, fall through to comma-separated parsing
            attachments = args.attachments.split(',').map((a: string) => a.trim()).filter(Boolean);
          }
        } catch {
          // Not valid JSON, fall through to comma-separated parsing
          attachments = args.attachments.split(',').map((a: string) => a.trim()).filter(Boolean);
        }
      } else {
        // Not JSON-like, use comma-separated parsing
        attachments = args.attachments.split(',').map((a: string) => a.trim()).filter(Boolean);
      }
    } else if (Array.isArray(args.attachments)) {
      attachments = args.attachments;
    }
  }
  
  if (args?.follow_up_prompts && Array.isArray(args.follow_up_prompts)) {
    follow_up_prompts = args.follow_up_prompts.filter((p: string) => p && p.trim().length > 0);
  }
  
  if (toolResult?.output && typeof toolResult.output === 'string') {
    text = text || toolResult.output;
  }
  
  return {
    text,
    attachments,
    follow_up_prompts,
    success: toolResult?.success ?? true
  };
}

